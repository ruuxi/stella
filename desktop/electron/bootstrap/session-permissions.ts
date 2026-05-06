import { session, type WebContents } from "electron";

const APP_ALLOWED_PERMISSIONS = new Set(["media", "display-capture"]);

const originFromUrl = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const isFileUrl = (value: string) => value.startsWith("file://");

const getWebContentsOrigin = (webContents: WebContents | null | undefined) => {
  const url = webContents?.getURL() ?? "";
  if (isFileUrl(url)) return "file://";
  return originFromUrl(url);
};

type ConfigureStellaSessionPermissionsOptions = {
  appPartition: string;
  isDev: boolean;
  getDevServerUrl: () => string;
};

export const configureStellaSessionPermissions = ({
  appPartition,
  isDev,
  getDevServerUrl,
}: ConfigureStellaSessionPermissionsOptions) => {
  const devOrigin = isDev ? originFromUrl(getDevServerUrl()) : null;
  const isTrustedAppContents = (
    webContents: WebContents | null | undefined,
  ) => {
    const origin = getWebContentsOrigin(webContents);
    return origin === "file://" || (devOrigin != null && origin === devOrigin);
  };
  const appSession = session.fromPartition(appPartition);
  const storeSession = session.fromPartition(`${appPartition}:store`);

  appSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(
        APP_ALLOWED_PERMISSIONS.has(permission) &&
          isTrustedAppContents(webContents),
      );
    },
  );

  appSession.setPermissionCheckHandler((webContents, permission) => {
    return (
      APP_ALLOWED_PERMISSIONS.has(permission) &&
      isTrustedAppContents(webContents)
    );
  });

  storeSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );

  storeSession.setPermissionCheckHandler(() => false);
};
