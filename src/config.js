const trimTrailingSlash = value => value.replace(/\/+$/, "");

export const API_BASE_URL = trimTrailingSlash(
  process.env.REACT_APP_API_BASE_URL || ""
);

// Okta OIDC configuration for JWT authentication
export const OKTA_ISSUER = process.env.REACT_APP_OKTA_ISSUER || "";
export const OKTA_CLIENT_ID = process.env.REACT_APP_OKTA_CLIENT_ID || "";

export const API_CONFIGURATION_ERROR =
  !API_BASE_URL ? "REACT_APP_API_BASE_URL" :
  !OKTA_ISSUER ? "REACT_APP_OKTA_ISSUER" :
  !OKTA_CLIENT_ID ? "REACT_APP_OKTA_CLIENT_ID" :
  "";
