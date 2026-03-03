"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { GoogleAuth } from "google-auth-library";
import { parseJsonObject, asNonEmptyString, withoutTrailingSlash } from "./lib/json";

async function resolveGoogleVertexToken(apiKey: string): Promise<string> {
  const parsed = parseJsonObject(apiKey);
  if (!parsed) {
    return apiKey.trim();
  }
  const auth = new GoogleAuth({ credentials: parsed });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const accessToken =
    typeof tokenResult === "string"
      ? tokenResult
      : tokenResult?.token ?? null;
  if (!accessToken) {
    throw new Error("Google Vertex token exchange returned no access token");
  }
  return accessToken;
}

async function resolveSapAiCoreAccessToken(apiKey: string): Promise<string> {
  const parsed = parseJsonObject(apiKey);
  if (!parsed) {
    return apiKey.trim();
  }

  const directToken = asNonEmptyString(parsed.access_token) ?? asNonEmptyString(parsed.accessToken);
  if (directToken) return directToken;

  const clientId = asNonEmptyString(parsed.clientid) ?? asNonEmptyString(parsed.clientId);
  const clientSecret = asNonEmptyString(parsed.clientsecret) ?? asNonEmptyString(parsed.clientSecret);
  const oauthBase = asNonEmptyString(parsed.url);
  if (!clientId || !clientSecret || !oauthBase) {
    return apiKey.trim();
  }

  const tokenUrl = `${withoutTrailingSlash(oauthBase)}/oauth/token`;
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) {
    throw new Error(`SAP AI Core token exchange failed (${response.status})`);
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("SAP AI Core token exchange returned no access_token");
  }
  return payload.access_token;
}

/**
 * Resolve auth headers for providers that require Node.js runtime
 * (GoogleAuth for Vertex, OAuth for SAP AI Core).
 */
export const resolveNodeAuthHeaders = internalAction({
  args: {
    provider: v.string(),
    apiKey: v.string(),
  },
  returns: v.record(v.string(), v.string()),
  handler: async (_ctx, { provider, apiKey }) => {
    switch (provider) {
      case "google-vertex":
      case "google-vertex-anthropic": {
        const accessToken = await resolveGoogleVertexToken(apiKey);
        return { Authorization: `Bearer ${accessToken}` };
      }
      case "sap-ai-core": {
        const accessToken = await resolveSapAiCoreAccessToken(apiKey);
        const resourceGroup = process.env.AICORE_RESOURCE_GROUP?.trim();
        return {
          Authorization: `Bearer ${accessToken}`,
          ...(resourceGroup ? { "AI-Resource-Group": resourceGroup } : {}),
        };
      }
      default:
        return { Authorization: `Bearer ${apiKey}` };
    }
  },
});
