/** Shared constants only. Importing this file does not access any storage. */
export const WEB_INIT_MODE='deferred-web-init';
export const WEB_INIT_TABLE='__substracker_web_init_v1';
export const WEB_INIT_PREFIX='__substracker_web_init_v1__:';
export const WEB_INIT_FORMAT='substracker-web-init-v1';

export const usesWebInit = run => run?.mode===WEB_INIT_MODE;
