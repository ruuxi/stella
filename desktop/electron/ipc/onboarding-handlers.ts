import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { AuthService } from "../services/auth-service.js";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "../../src/shared/contracts/onboarding.js";

type BrowserFetchInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

type OnboardingHandlersOptions = {
  authService: AuthService;
  getDeviceId: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

type OnboardingServiceRequestOptions = {
  includeAuth?: boolean;
  includeDeviceId?: boolean;
};

const ONBOARDING_FETCH_TIMEOUT_MS = 180_000;

const normalizeServicePath = (value: string) =>
  value.startsWith("/") ? value : `/${value}`;

const resolveServiceEndpoint = (
  authService: AuthService,
  servicePath: string,
): string => {
  const baseUrl = authService.getConvexSiteUrl();
  if (!baseUrl) {
    throw new Error("Service base URL is not configured.");
  }
  return new URL(normalizeServicePath(servicePath), baseUrl).toString();
};

const createOnboardingServiceRequest = async (
  authService: AuthService,
  getDeviceId: () => string | null,
  servicePath: string,
  headers: Record<string, string> = {},
  options: OnboardingServiceRequestOptions = {},
) => {
  const endpoint = resolveServiceEndpoint(authService, servicePath);
  const includeAuth = options.includeAuth ?? true;
  const includeDeviceId = options.includeDeviceId ?? true;

  const requestHeaders = { ...headers };
  const [token, deviceId] = await Promise.all([
    includeAuth ? authService.getAuthToken() : Promise.resolve(null),
    includeDeviceId ? Promise.resolve(getDeviceId()) : Promise.resolve(null),
  ]);

  if (token && !requestHeaders.Authorization) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  if (deviceId && !requestHeaders["X-Device-ID"]) {
    requestHeaders["X-Device-ID"] = deviceId;
  }

  return {
    endpoint,
    headers: requestHeaders,
  };
};

const invokeOnboardingJson = async <TResponse>(
  authService: AuthService,
  getDeviceId: () => string | null,
  servicePath: string,
  payload: Record<string, unknown>,
  options: OnboardingServiceRequestOptions = {},
): Promise<TResponse> => {
  const request = await createOnboardingServiceRequest(
    authService,
    getDeviceId,
    servicePath,
    { "Content-Type": "application/json" },
    options,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(
        `${servicePath} timed out after ${ONBOARDING_FETCH_TIMEOUT_MS}ms`,
      ),
    );
  }, ONBOARDING_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `${servicePath} timed out after ${ONBOARDING_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `${servicePath} failed (${response.status} ${response.statusText}): ${errorText}`,
    );
  }

  return (await response.json()) as TResponse;
};

export const registerOnboardingHandlers = (
  options: OnboardingHandlersOptions,
) => {
  ipcMain.handle(
    "onboarding:synthesizeCoreMemory",
    async (
      event,
      payload: OnboardingSynthesisRequest,
    ) => {
      if (
        !options.assertPrivilegedSender(event, "onboarding:synthesizeCoreMemory")
      ) {
        throw new Error(
          "Blocked untrusted onboarding:synthesizeCoreMemory request.",
        );
      }

      return await invokeOnboardingJson<OnboardingSynthesisResponse>(
        options.authService,
        options.getDeviceId,
        "/api/synthesize",
        {
          formattedSections: payload?.formattedSections ?? {},
          ...(payload?.promptConfig ?? {}),
        },
        {
          includeAuth: payload?.includeAuth ?? true,
        },
      );
    },
  );

};
