import { handlePagesRequest } from '../src/pages-handler.js';

export function onRequest(context) {
  return handlePagesRequest(context);
}
