import type { NotificationKind } from "./protocol";

export const DEFAULT_BACKEND_BASE_URL = "http://localhost:3000";
export const SEEK_SYNC_THRESHOLD_MS = 1500;
export const SEEK_DETECTION_TOLERANCE_MS = 1800;
export const LOCAL_STORAGE_KEYS = {
  backendBaseUrl: "together_backend_base_url",
  displayName: "together_display_name",
  profileImageUrl: "together_profile_image_url"
} as const;

export const createId = (prefix: string) => {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
};

export const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BACKEND_BASE_URL;
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const formatDuration = (ms: number) => {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const readSpicetifyStorage = (key: string) => {
  const storage = Spicetify?.LocalStorage;
  if (!storage) {
    return localStorage.getItem(key);
  }

  return storage.get(key);
};

export const writeSpicetifyStorage = (key: string, value: string) => {
  const storage = Spicetify?.LocalStorage;
  if (!storage) {
    localStorage.setItem(key, value);
    return;
  }

  storage.set(key, value);
};

export const showGlobalNotification = (message: string, kind: NotificationKind = "info") => {
  const prefix = kind === "error" ? "Together error" : "Together";
  if (Spicetify?.showNotification) {
    Spicetify.showNotification(`${prefix}: ${message}`);
  }
};
