import { Context, MiddlewareFn } from 'telegraf';
import config from '../utils/config';

/**
 * Global gate: every user-originated update is silently dropped unless the sender
 * is the configured admin. Channel posts (no `from`) are allowed through so the
 * publisher can still emit messages.
 */
export const adminGate: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) {
    // Not a user message (e.g. channel post / my_chat_member) — let through.
    return next();
  }
  if (userId !== config.adminUserId) {
    // Silent drop. Bot is single-tenant; non-admins get no acknowledgement.
    return;
  }
  return next();
};
