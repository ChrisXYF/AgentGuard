const CLIENT_ID_STORAGE_KEY = "agents-of-shield.client-id";

function createDesktopDeviceId() {
  return typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `agentguard-desktop-${Date.now().toString(36)}`;
}

export function getDesktopDeviceId() {
  if (typeof window === "undefined") {
    return "agentguard-desktop";
  }

  const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = createDesktopDeviceId();
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
  return generated;
}

export function resetDesktopDeviceId() {
  if (typeof window === "undefined") {
    return "agentguard-desktop";
  }

  const nextValue = createDesktopDeviceId();
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, nextValue);
  return nextValue;
}

export const getDesktopClientId = getDesktopDeviceId;
