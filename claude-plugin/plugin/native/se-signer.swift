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
//   se-signer serve --key <name>=<path> ...      -> line protocol on stdin/stdout:
//       in:  {"id":1,"key":"routine","data":"<base64url bytes>","reason":"<Touch ID prompt>"}
//       out: {"id":1,"sig":"<base64url raw r||s>"}  or  {"id":1,"error":"..."}
//
// Signatures are ES256 (ECDSA P-256 over SHA-256), raw r||s, ready for JWS.

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

case "serve":
    var keys: [String: SecureEnclave.P256.Signing.PrivateKey] = [:]
    var paths: [String: String] = [:]
    for spec in argValues("--key") {
        let parts = spec.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { fail("bad --key \(spec), expected name=path") }
        do { keys[parts[0]] = try loadKey(parts[1]); paths[parts[0]] = parts[1] } catch { fail("load \(parts[0]): \(error)") }
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
            // A request with a reason gets a fresh authentication context, so the Touch ID
            // prompt says why. One touch is reused for 10 s (e.g. unlock + first request).
            if let reason = req["reason"] as? String, let path = paths[name] {
                let ctx = LAContext()
                ctx.localizedReason = reason
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
