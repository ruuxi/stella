import { createHash, generateKeyPairSync, sign, verify } from "crypto";
import path from "path";
import { promises as fs } from "fs";
const getKeyPath = (stateStore) => path.join(stateStore.signingDir, "device-key.json");
const stableSort = (value) => {
    if (Array.isArray(value)) {
        return value.map((item) => stableSort(item));
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const record = value;
    const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const next = {};
    for (const key of sortedKeys) {
        next[key] = stableSort(record[key]);
    }
    return next;
};
export const stableStringify = (value) => {
    return JSON.stringify(stableSort(value));
};
export const hashCanonicalJson = (value) => {
    const canonical = stableStringify(value);
    const hash = createHash("sha256");
    hash.update(canonical, "utf-8");
    return {
        canonical,
        hashHex: hash.digest("hex"),
    };
};
const createKeys = () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    return {
        publicKeyPem,
        privateKeyPem,
        createdAt: Date.now(),
    };
};
export const ensureSigningKeys = async (stateStore) => {
    const keyPath = getKeyPath(stateStore);
    try {
        const raw = await fs.readFile(keyPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed?.privateKeyPem && parsed?.publicKeyPem) {
            return parsed;
        }
    }
    catch {
        // Fall through to create.
    }
    const created = createKeys();
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, JSON.stringify(created, null, 2), "utf-8");
    return created;
};
export const signHash = (privateKeyPem, hashHex) => {
    const signature = sign(null, Buffer.from(hashHex, "hex"), privateKeyPem);
    return signature.toString("base64");
};
export const verifySignature = (publicKeyPem, hashHex, signatureBase64) => {
    try {
        return verify(null, Buffer.from(hashHex, "hex"), publicKeyPem, Buffer.from(signatureBase64, "base64"));
    }
    catch {
        return false;
    }
};
