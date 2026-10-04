// se-signer: Secure Enclave P-256 key helper for the bridge.
//
// The private key is generated inside the Secure Enclave and never leaves it.
// What we store on disk is CryptoKit's `dataRepresentation`: an opaque blob that
// only this device's Secure Enclave can use. Copying it to another machine is useless.
//
// Commands (all output is one JSON object per line on stdout):
//   se-signer probe
//   se-signer create --out <path> [--presence]   -> {"jwk":{...}}
//   se-signer pubkey --key <path>                -> {"jwk":{...}}
//   se-signer describe                           -> stdin {"data":...,"body":...}, out {"reason":"..."}
//   se-signer serve --key <name>=<path> ...      -> line protocol on stdin/stdout:
//       in:  {"id":1,"key":"routine","data":"<base64url JWS signing input>","body":"<base64url HTTP body>"}
//       out: {"id":1,"sig":"<base64url raw r||s>"}  or  {"id":1,"error":"..."}
//
// Signatures are ES256 (ECDSA P-256 over SHA-256), raw r||s, ready for JWS.
//
// Touch ID prompts are written here, from what is being signed, never by the caller.
// Any process of this user can start this binary, so caller-supplied text would let
// malware show "unlock company tools" while signing a destructive call. `data` must be
// a DPoP signing input (header.claims); for a key that needs Touch ID, `body` must hash
// to the `bh` claim, and the prompt names the tool and arguments found in it.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

func b64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func fromB64url(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
}

func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ msg: String) -> Never {
    emit(["error": msg])
    exit(1)
}

func jwk(_ key: SecureEnclave.P256.Signing.PrivateKey) -> [String: String] {
    // x963: 0x04 || X(32) || Y(32)
    let raw = key.publicKey.x963Representation
    return [
        "kty": "EC",
        "crv": "P-256",
        "x": b64url(raw.subdata(in: 1..<33)),
        "y": b64url(raw.subdata(in: 33..<65)),
    ]
}

func loadKey(_ path: String, context: LAContext? = nil) throws -> SecureEnclave.P256.Signing.PrivateKey {
    let blob = try Data(contentsOf: URL(fileURLWithPath: path))
    return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
}

struct SignError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

/// Text from the request is shown in a system dialog: drop line breaks, control characters and
/// bidi overrides, which could make the prompt read differently from what is signed.
func printable(_ s: String) -> String {
    String(String.UnicodeScalarView(s.unicodeScalars.map { c in
        let bidi = (0x202A...0x202E).contains(c.value) || (0x2066...0x2069).contains(c.value)
            || c.value == 0x200E || c.value == 0x200F || c.value == 0x061C
        return CharacterSet.controlCharacters.contains(c) || bidi ? " " : c
    }))
}

func clip(_ s: String, _ n: Int) -> String {
    let s = printable(s)
    return s.count <= n ? s : String(s.prefix(n - 1)) + "…"
}

func compactJson(_ v: Any) -> String {
    if let s = v as? String { return s }
    guard JSONSerialization.isValidJSONObject([v]),
          let d = try? JSONSerialization.data(withJSONObject: [v], options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]),
          let s = String(data: d, encoding: .utf8)
    else { return "\(v)" }
    return String(s.dropFirst().dropLast())
}

/// "key: value, key: value" with every value and the whole line clipped for the prompt.
func describeArgs(_ args: Any?) -> String {
    guard let dict = args as? [String: Any], !dict.isEmpty else { return "no arguments" }
    let parts = dict.keys.sorted().map { "\($0): \(clip(compactJson(dict[$0]!), 40))" }
    return clip(parts.joined(separator: ", "), 140)
}

/// The Touch ID prompt for signing `data` (a JWS signing input) over the HTTP `body`.
/// macOS shows it as "hy-guard is trying to <reason>".
func presenceReason(data: Data, body: Data?) throws -> String {
    let parts = (String(data: data, encoding: .utf8) ?? "").split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2, let raw = fromB64url(String(parts[1])),
          let claims = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
          let htm = claims["htm"] as? String, let htu = claims["htu"] as? String, let url = URL(string: htu)
    else { throw SignError("not a DPoP signing input") }
    let host = url.host ?? htu

    var bodyText: String?
    if let bh = claims["bh"] as? String {
        guard let body else { throw SignError("the request body is required for a Touch ID signature") }
        guard b64url(Data(SHA256.hash(data: body))) == bh else { throw SignError("the request body does not match the signed body hash") }
        bodyText = String(data: body, encoding: .utf8)
    }

    if let text = bodyText, let d = text.data(using: .utf8),
       let rpc = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
       rpc["method"] as? String == "tools/call",
       let params = rpc["params"] as? [String: Any], let tool = params["name"] as? String {
        return "run \(clip(tool, 60)) via \(host) (\(describeArgs(params["arguments"])))"
    }
    if let text = bodyText, URLComponents(string: "?" + text)?.queryItems?
        .contains(where: { $0.name == "grant_type" && $0.value == "refresh_token" }) == true {
        return "unlock company tools for Claude Code (\(host))"
    }
    return "send \(htm) \(clip(url.path, 60)) to \(host)"
}

/// Does signing with this key need Touch ID? Try once with interaction forbidden.
/// Decided from the key itself, not from the name the caller gave it.
func needsPresence(_ path: String) -> Bool {
    let ctx = LAContext()
    ctx.interactionNotAllowed = true
    guard let key = try? loadKey(path, context: ctx) else { return true }
    return (try? key.signature(for: Data("hy-guard presence probe".utf8))) == nil
}

func argValues(_ name: String) -> [String] {
    var out: [String] = []
    let args = CommandLine.arguments
    var i = 0
    while i < args.count {
        if args[i] == name, i + 1 < args.count { out.append(args[i + 1]); i += 1 }
        i += 1
    }
    return out
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: se-signer probe|create|pubkey|serve") }

switch args[1] {
case "probe":
    emit(["secure_enclave": SecureEnclave.isAvailable])

case "create":
    guard SecureEnclave.isAvailable else { fail("secure enclave not available") }
    guard let out = argValues("--out").first else { fail("missing --out") }
    var flags: SecAccessControlCreateFlags = [.privateKeyUsage]
    if args.contains("--presence") { flags.insert(.userPresence) }
    var cfErr: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &cfErr)
    else { fail("access control: \(String(describing: cfErr?.takeRetainedValue()))") }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        let url = URL(fileURLWithPath: out)
        try key.dataRepresentation.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: out)
        emit(["jwk": jwk(key)])
    } catch { fail("create: \(error)") }

case "pubkey":
    guard let path = argValues("--key").first else { fail("missing --key") }
    do { emit(["jwk": jwk(try loadKey(path))]) } catch { fail("pubkey: \(error)") }

case "describe":
    guard let line = readLine(strippingNewline: true), let d = line.data(using: .utf8),
          let req = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let data = (req["data"] as? String).flatMap(fromB64url)
    else { fail("expected {\"data\":...,\"body\":...} on stdin") }
    do { emit(["reason": try presenceReason(data: data, body: (req["body"] as? String).flatMap(fromB64url))]) }
    catch { fail("\(error)") }

case "serve":
    var keys: [String: SecureEnclave.P256.Signing.PrivateKey] = [:]
    var paths: [String: String] = [:]
    var presence: Set<String> = []
    for spec in argValues("--key") {
        let parts = spec.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { fail("bad --key \(spec), expected name=path") }
        do { keys[parts[0]] = try loadKey(parts[1]); paths[parts[0]] = parts[1] } catch { fail("load \(parts[0]): \(error)") }
        if needsPresence(parts[1]) { presence.insert(parts[0]) }
    }
    emit(["ready": true, "keys": Array(keys.keys).sorted()])
    while let line = readLine(strippingNewline: true) {
        guard let d = line.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
        else { continue }
        let id = req["id"] ?? NSNull()
        guard let name = req["key"] as? String, let key = keys[name] else {
            emit(["id": id, "error": "unknown key"]); continue
        }
        guard let s = req["data"] as? String, let payload = fromB64url(s) else {
            emit(["id": id, "error": "bad data"]); continue
        }
        do {
            var signer = key
            // A Touch ID key gets a fresh authentication context per request, so the prompt
            // describes this request. One touch is reused for 10 s (e.g. unlock + first request).
            if presence.contains(name), let path = paths[name] {
                let ctx = LAContext()
                ctx.localizedReason = try presenceReason(data: payload, body: (req["body"] as? String).flatMap(fromB64url))
                ctx.touchIDAuthenticationAllowableReuseDuration = 10
                signer = try loadKey(path, context: ctx)
            }
            let sig = try signer.signature(for: payload)
            emit(["id": id, "sig": b64url(sig.rawRepresentation)])
        } catch {
            emit(["id": id, "error": "sign: \(error)"])
        }
    }

default:
    fail("unknown command \(args[1])")
}
