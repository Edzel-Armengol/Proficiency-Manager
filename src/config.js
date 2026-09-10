const trimTrailingSlash = value => value.replace(/\/+$/, "");

export const API_BASE_URL = trimTrailingSlash(
  process.env.REACT_APP_API_BASE_URL || ""
);

export const API_CONFIGURATION_ERROR = !API_BASE_URL
  ? "REACT_APP_API_BASE_URL"
  : "";
