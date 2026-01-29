import { authClient } from "@/lib/auth-client";

export const getAuthToken = async (): Promise<string | null> => {
  try {
    const response = await authClient.$fetch("/convex/token", { method: "GET" });
    const token =
      (response as { data?: { token?: string } })?.data?.token ??
      (response as { token?: string })?.token ??
      null;
    return token ?? null;
  } catch {
    return null;
  }
};
