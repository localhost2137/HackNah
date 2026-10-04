import { z } from 'zod'

/**
 * Signatures of attacks that already happened: code execution, unsafe deserialization, supply
 * chain packages, tool poisoning. The gateway matches them in the `signatures` workflow block.
 * A built-in baseline ships with the gateway; more arrive as a feed from an externally managed
 * system (`SIGNATURE_FEED_URL`), in the same format.
 */

export const signatureSeverity = z.enum(['low', 'medium', 'high', 'critical'])
export type SignatureSeverity = z.infer<typeof signatureSeverity>

export const signatureCategory = z.enum([
  'code_execution',
  'deserialization',
  'supply_chain',
  'destructive_command',
  'exfiltration',
  'prompt_injection',
  'tool_poisoning',
  'agent_tampering',
])
export type SignatureCategory = z.infer<typeof signatureCategory>

export const signature = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  /**
   * `regex`: `pattern` is a case-insensitive regular expression. `package`: `pattern` is a
   * package name, matched where a command installs or runs it (pip, uv, npm, npx, pnpm, ...).
   */
  type: z.enum(['regex', 'package']),
  pattern: z.string().min(1).max(2000),
  category: signatureCategory,
  severity: signatureSeverity.default('high'),
  /** Where the signature comes from, e.g. "OSV" or "MITRE ATLAS". */
  source: z.string().max(120).default(''),
  /** CVE id, advisory id or URL of the incident. */
  reference: z.string().max(500).default(''),
})
export type Signature = z.infer<typeof signature>

export const signatureFeed = z.object({
  version: z.string().default(''),
  signatures: z.array(signature).max(20_000),
})
export type SignatureFeed = z.infer<typeof signatureFeed>

const severityRank: Record<SignatureSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

export const severityRisk: Record<SignatureSeverity, number> = {
  low: 0.4,
  medium: 0.6,
  high: 0.85,
  critical: 1,
}

const INSTALLERS = String.raw`\b(?:pip3?\s+install|python3?\s+-m\s+pip\s+install|uv\s+(?:pip\s+install|add|tool\s+install)|uvx|poetry\s+add|pipx\s+(?:install|run)|npm\s+(?:i|install|add|exec)|pnpm\s+(?:add|dlx|i|install)|yarn\s+(?:add|dlx)|npx|bunx|bun\s+(?:add|x))\b`

const INSTALL_COMMAND = new RegExp(`${INSTALLERS}([^\\n;|&]*)`, 'gi')

/** The package names a command installs or runs: `pip install a "b==1.0"` gives a and b. */
function installedPackages(text: string): string[] {
  const names: string[] = []
  for (const command of text.matchAll(INSTALL_COMMAND)) {
    for (const raw of (command[1] ?? '').split(/\s+/)) {
      // Drop surrounding quotes and brackets, then a version or extras suffix:
      // `pkg==1.0`, `pkg@1.0`, `pkg[extra]`, `@scope/pkg@1.0`.
      const token = raw.replace(/^["'`({[]+/, '')
      const name = /^(@?[A-Za-z0-9._/-]+)/.exec(token)?.[1]
      if (name && !name.startsWith('-')) names.push(name.toLowerCase())
    }
  }
  return names
}

type CompiledSignatures = {
  /** Package signatures by lower-cased name: one lookup per installed package, whatever the feed size. */
  packages: Map<string, Signature>
  /** Regex signatures, most severe first, so matching can stop at the first hit. */
  regexes: { sig: Signature; re: RegExp }[]
}

const compiledSets = new WeakMap<Signature[], CompiledSignatures>()

/**
 * Compiles a signature list once per list. Package signatures become a hash map instead of one
 * regular expression each: a feed of tens of thousands of malicious packages costs the same per
 * request as a feed of ten.
 */
function compileSignatures(signatures: Signature[]): CompiledSignatures {
  const cached = compiledSets.get(signatures)
  if (cached) return cached
  const packages = new Map<string, Signature>()
  const regexes: CompiledSignatures['regexes'] = []
  for (const sig of signatures) {
    if (sig.type === 'package') {
      const name = sig.pattern.toLowerCase()
      const existing = packages.get(name)
      if (!existing || severityRank[sig.severity] > severityRank[existing.severity])
        packages.set(name, sig)
      continue
    }
    try {
      regexes.push({ sig, re: new RegExp(sig.pattern, 'i') })
    } catch {
      // A broken pattern in a feed must not take the other signatures down with it.
    }
  }
  regexes.sort((a, b) => severityRank[b.sig.severity] - severityRank[a.sig.severity])
  const set = { packages, regexes }
  compiledSets.set(signatures, set)
  return set
}

const SHELL_SEPARATOR = /\$\{IFS\}|\$IFS\b|\\\n/g
const ZERO_WIDTH = /[​-‍⁠﻿]/g
const BASE64_RUN = /[A-Za-z0-9+/_-]{24,}={0,2}/g

function decodeBase64(run: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(run.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    )
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Only keep decodes that read as text; random tokens decode to control characters.
    const printable = text.replace(/[^\x20-\x7E\n\t]/g, '').length
    return printable / text.length > 0.9 ? text : null
  } catch {
    return null
  }
}

/**
 * The forms of a text worth matching: as sent, with Unicode look-alikes, zero-width characters
 * and shell separators folded, and with base64 runs decoded. Attacks hide in the last two.
 */
export function textVariants(text: string): string[] {
  const variants = [text]
  // Shell word splitting tricks (`rm${IFS}-rf`) and line breaks stand in for spaces.
  const folded = text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(SHELL_SEPARATOR, ' ')
    .replace(/\s+/g, ' ')
  if (folded !== text) variants.push(folded)
  const decoded = (folded.match(BASE64_RUN) ?? [])
    .slice(0, 20)
    .map(decodeBase64)
    .filter((t): t is string => t !== null)
  if (decoded.length) variants.push(decoded.join('\n'))
  return variants
}

/**
 * The most severe signature that matches the text, or null. Only signatures at or above
 * `minSeverity` count, and only those in `categories` when any are given.
 */
export function matchSignatures(
  text: string,
  signatures: Signature[],
  minSeverity: SignatureSeverity = 'low',
  categories: SignatureCategory[] = [],
): Signature | null {
  const { packages, regexes } = compileSignatures(signatures)
  const variants = textVariants(text)
  const wanted = (sig: Signature) =>
    severityRank[sig.severity] >= severityRank[minSeverity] &&
    (categories.length === 0 || categories.includes(sig.category))

  let best: Signature | null = null
  for (const variant of variants) {
    for (const name of installedPackages(variant)) {
      const sig = packages.get(name)
      if (sig && wanted(sig) && (!best || severityRank[sig.severity] > severityRank[best.severity]))
        best = sig
    }
  }
  for (const { sig, re } of regexes) {
    // Sorted most severe first: once nothing left can outrank the best hit, stop.
    if (best && severityRank[sig.severity] <= severityRank[best.severity]) break
    if (wanted(sig) && variants.some((v) => re.test(v))) {
      best = sig
      break
    }
  }
  return best
}

/** Later feeds override earlier entries with the same id. */
export function mergeSignatures(...lists: Signature[][]): Signature[] {
  const byId = new Map<string, Signature>()
  for (const list of lists) for (const sig of list) byId.set(sig.id, sig)
  return [...byId.values()]
}

type Optional = 'type' | 'severity' | 'reference'
const baseline = (
  list: (Omit<Signature, Optional> & Partial<Pick<Signature, Optional>>)[],
): Signature[] => list.map((s) => ({ type: 'regex', severity: 'high', reference: '', ...s }))

/** Ships with the gateway, so the block works before any feed is configured. */
export const baselineSignatures: Signature[] = baseline([
  {
    id: 'exec-python-os-system-import',
    title: 'Python code execution through __import__',
    pattern: String.raw`__import__\(\s*['"](?:os|subprocess|pty)['"]\s*\)`,
    category: 'code_execution',
    severity: 'critical',
    source: 'LangChain LLMMathChain',
    reference: 'CVE-2023-29374',
  },
  {
    id: 'exec-pipe-to-shell',
    title: 'Remote script piped into a shell',
    pattern: String.raw`\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b`,
    category: 'code_execution',
    severity: 'critical',
    source: 'Baseline',
  },
  {
    id: 'exec-base64-to-shell',
    title: 'Decoded payload piped into a shell',
    pattern: String.raw`base64\s+(?:-d|-D|--decode)[^\n|]*\|\s*(?:ba|z)?sh\b`,
    category: 'code_execution',
    severity: 'critical',
    source: 'Baseline',
  },
  {
    id: 'exec-reverse-shell',
    title: 'Reverse shell',
    pattern: String.raw`(?:ba)?sh\s+-i\s+>&\s*/dev/tcp/|\bnc(?:at)?\b[^\n]*\s-e\s+/bin/(?:ba)?sh`,
    category: 'code_execution',
    severity: 'critical',
    source: 'Baseline',
  },
  {
    id: 'deser-pickle-load',
    title: 'Unsafe pickle deserialization',
    pattern: String.raw`\b(?:pickle|cPickle|dill|cloudpickle)\.loads?\(`,
    category: 'deserialization',
    severity: 'medium',
    source: 'Malicious pickle models on model repositories',
    reference: 'https://atlas.mitre.org/techniques/AML.T0010',
  },
  {
    id: 'deser-torch-load-remote',
    title: 'torch.load of a remote or unrestricted file',
    pattern: String.raw`torch\.load\([^)]*(?:https?://|weights_only\s*=\s*False)`,
    category: 'deserialization',
    source: 'PyTorch',
    reference: 'CVE-2025-32434',
  },
  {
    id: 'deser-yaml-unsafe-load',
    title: 'Unsafe YAML load',
    pattern: String.raw`yaml\.(?:unsafe_load|load\((?![^)]*Safe))`,
    category: 'deserialization',
    severity: 'medium',
    source: 'Baseline',
  },
  {
    id: 'deser-numpy-joblib-pickle',
    title: 'NumPy or joblib load that executes pickled code',
    pattern: String.raw`allow_pickle\s*=\s*True|\bjoblib\.load\(`,
    category: 'deserialization',
    severity: 'medium',
    source: 'Baseline',
  },
  {
    id: 'deser-keras-unsafe-model',
    title: 'Keras model loaded with safe mode off',
    pattern: String.raw`load_model\([^)]*safe_mode\s*=\s*False`,
    category: 'deserialization',
    source: 'Keras Lambda layer code execution',
    reference: 'CVE-2024-3660',
  },
  {
    id: 'model-repo-trust-remote-code',
    title: 'Model repository code executed on load',
    pattern: String.raw`trust_remote_code\s*=\s*True|--trust[-_]remote[-_]code`,
    category: 'supply_chain',
    source: 'Malicious models on Hugging Face',
    reference: 'https://atlas.mitre.org/techniques/AML.T0010',
  },
  {
    id: 'model-repo-pickle-weights',
    title: 'Pickle-format model file fetched from a model repository',
    pattern: String.raw`(?:huggingface\.co/[^\s"')]+/resolve/[^\s"')]+|hf_hub_download\([^)]*|huggingface-cli\s+download[^\n]*|hf\s+download[^\n]*)\.(?:pkl|pickle|pt|pth|bin|ckpt|joblib)\b`,
    category: 'supply_chain',
    severity: 'medium',
    source: 'Malicious pickle models on Hugging Face',
    reference: 'https://atlas.mitre.org/techniques/AML.T0010',
  },
  {
    id: 'deser-read-pickle-remote',
    title: 'Pickle file read straight from a URL',
    pattern: String.raw`read_pickle\(\s*['"]https?://`,
    category: 'deserialization',
    source: 'Baseline',
  },
  {
    id: 'exec-template-injection',
    title: 'Template that reaches Python internals',
    pattern: String.raw`\{\{[^}\n]{0,200}__(?:class|globals|subclasses|builtins|import)__`,
    category: 'code_execution',
    severity: 'critical',
    source: 'llama-cpp-python model metadata template injection',
    reference: 'CVE-2024-34359',
  },
  {
    id: 'exec-langflow-validate-code',
    title: 'Langflow code validation endpoint',
    pattern: String.raw`/api/v1/validate/code\b`,
    category: 'code_execution',
    source: 'Langflow unauthenticated remote code execution',
    reference: 'CVE-2025-3248',
  },
  {
    id: 'exec-langchain-dangerous-flags',
    title: 'LangChain run with its code-execution safety off',
    pattern: String.raw`allow_dangerous_(?:code|deserialization|requests)\s*=\s*True|\bPALChain\b`,
    category: 'code_execution',
    severity: 'medium',
    source: 'LangChain arbitrary code execution',
    reference: 'CVE-2023-36258',
  },
  {
    id: 'exec-ray-dashboard-exposed',
    title: 'Ray job API exposed on every network interface',
    pattern: String.raw`\bray\s+start\b[^\n]*--dashboard-host[= ]0\.0\.0\.0`,
    category: 'code_execution',
    severity: 'medium',
    source: 'ShadowRay attacks on exposed Ray clusters',
    reference: 'CVE-2023-48022',
  },
  {
    id: 'model-repo-ollama-untrusted-registry',
    title: 'Ollama model pulled from an outside registry',
    pattern: String.raw`\bollama\s+(?:pull|run)\s+(?:https?://)?(?!hf\.co/|huggingface\.co/|registry\.ollama\.ai/)(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?/`,
    category: 'supply_chain',
    severity: 'medium',
    source: 'Ollama model registry path traversal (Probllama)',
    reference: 'CVE-2024-37032',
  },
  {
    id: 'supply-mcp-remote-vulnerable',
    title: 'mcp-remote version with command injection',
    pattern: String.raw`mcp-remote@0\.(?:0\.\d+|1\.(?:\d|1[0-5]))(?![\d.])`,
    category: 'supply_chain',
    source: 'mcp-remote OS command injection from an untrusted MCP server',
    reference: 'CVE-2025-6514',
  },
  {
    id: 'supply-mcp-inspector-vulnerable',
    title: 'MCP Inspector version with an unauthenticated proxy',
    pattern: String.raw`@modelcontextprotocol/inspector@0\.(?:\d|1[0-3])\.\d+(?![\d.])`,
    category: 'supply_chain',
    source: 'MCP Inspector remote code execution',
    reference: 'CVE-2025-49596',
  },
  ...['deepseeek', 'deepseekai', 'aiocpa', 'fabrice'].map(
    (name): Omit<Signature, Optional> & Partial<Pick<Signature, Optional>> => ({
      id: `supply-${name}`,
      title: `Malicious package ${name}`,
      type: 'package',
      pattern: name,
      category: 'supply_chain',
      severity: 'critical',
      source: 'OSV malicious package records',
    }),
  ),
  {
    id: 'supply-torchtriton',
    title: 'Dependency-confusion package torchtriton',
    type: 'package',
    pattern: 'torchtriton',
    category: 'supply_chain',
    severity: 'critical',
    source: 'PyTorch nightly compromise, December 2022',
    reference: 'https://pytorch.org/blog/compromised-nightly-dependency/',
  },
  {
    id: 'supply-postmark-mcp',
    title: 'Backdoored MCP server postmark-mcp',
    type: 'package',
    pattern: 'postmark-mcp',
    category: 'supply_chain',
    severity: 'critical',
    source: 'First malicious MCP server found in the wild, September 2025',
  },
  {
    id: 'supply-ultralytics-compromised',
    title: 'Compromised ultralytics releases',
    pattern: String.raw`ultralytics==8\.3\.4[12]\b`,
    category: 'supply_chain',
    severity: 'critical',
    source: 'Ultralytics PyPI compromise, December 2024',
  },
  {
    id: 'destroy-wipe-home-or-root',
    title: 'Recursive delete of the home or root directory',
    pattern: String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(?:--no-preserve-root\s+)?(?:~|/|\$HOME)(?=\s|$|/\*|["'\\])`,
    category: 'destructive_command',
    severity: 'critical',
    source: 'Amazon Q extension wiper prompt, July 2025',
  },
  {
    id: 'destroy-cloud-resources',
    title: 'Bulk deletion of cloud resources',
    pattern: String.raw`aws\s+(?:ec2\s+terminate-instances|s3\s+rb\b[^\n]*--force|iam\s+delete-user)|near-factory state`,
    category: 'destructive_command',
    source: 'Amazon Q extension wiper prompt, July 2025',
  },
  {
    id: 'exfil-read-credentials',
    title: 'Reading local credential files',
    pattern: String.raw`\b(?:cat|less|head|tail|base64|scp|curl[^\n]*(?:-d|--data(?:-binary)?|-F)\s*@)\s*[^\n]*(?:\.ssh/id_[a-z0-9]+|\.aws/credentials|\.netrc)\b`,
    category: 'exfiltration',
    source: 'Baseline',
  },
  {
    id: 'exfil-markdown-image',
    title: 'Markdown image that carries data in its URL',
    pattern: String.raw`!\[[^\]]*\]\(https?://[^)\s]+\?[^)\s]*=[^)\s]{16,}\)`,
    category: 'exfiltration',
    severity: 'medium',
    source: 'EchoLeak, Microsoft 365 Copilot',
    reference: 'CVE-2025-32711',
  },
  {
    id: 'exfil-environment-to-network',
    title: 'Environment variables or .env piped to the network',
    pattern: String.raw`(?:\bprintenv\b|\benv\b|\bcat\s+[^\n|]*\.env\b[^\n|]*)\s*\|\s*(?:curl|nc|ncat|wget)\b`,
    category: 'exfiltration',
    source: 's1ngularity (Nx) credential harvesting, August 2025',
  },
  {
    id: 'destroy-fork-bomb',
    title: 'Fork bomb',
    pattern: String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`,
    category: 'destructive_command',
    source: 'Baseline',
  },
  {
    id: 'inject-ignore-instructions',
    title: 'Instruction override',
    pattern: String.raw`\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions|prompts?|rules|messages)`,
    category: 'prompt_injection',
    severity: 'medium',
    source: 'Baseline',
  },
  {
    id: 'poison-hidden-tool-instructions',
    title: 'Hidden instructions in a tool description',
    pattern: String.raw`<IMPORTANT>[\s\S]{0,600}(?:id_rsa|\.ssh|mcp\.json|do\s+not\s+(?:tell|mention|inform))`,
    category: 'tool_poisoning',
    severity: 'critical',
    source: 'MCP tool poisoning, Invariant Labs, April 2025',
  },
  {
    id: 'tamper-agent-config',
    title: 'Write to an agent configuration file',
    pattern: String.raw`(?:>>?|\btee\b|"file_path"\s*:\s*")[^\n"]*(?:\.cursor/mcp\.json|\.mcp\.json|\.claude/settings(?:\.local)?\.json)`,
    category: 'agent_tampering',
    source: 'CurXecute and MCPoison in Cursor',
    reference: 'CVE-2025-54135',
  },
  {
    id: 'tamper-editor-auto-approve',
    title: 'Editor setting that auto-approves agent tool calls',
    pattern: String.raw`chat\.tools\.autoApprove`,
    category: 'agent_tampering',
    source: 'GitHub Copilot command injection through workspace settings',
    reference: 'CVE-2025-53773',
  },
  {
    id: 'tamper-ssh-authorized-keys',
    title: 'Key added to SSH authorized_keys',
    pattern: String.raw`>>?\s*[^\n]*\.ssh/authorized_keys\b`,
    category: 'agent_tampering',
    source: 'Baseline',
  },
  {
    id: 'tamper-skip-permissions',
    title: 'Agent started with its permission checks disabled',
    pattern: String.raw`--dangerously-skip-permissions|--yolo\b|--trust-all-tools`,
    category: 'agent_tampering',
    severity: 'medium',
    source: 's1ngularity (Nx) supply chain attack, August 2025',
  },
])
