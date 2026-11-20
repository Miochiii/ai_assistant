import { a as DesktopBackend } from "./backend-BPKFhD__.js";
import { Context } from "@deepseek-ai/cordis";
//#region src/lasso-service.d.ts
/** Cordis plugin name for the app-level provider row in `cordis.patch.yml`. */
declare const name = "computer-use-lasso";
/**
 * Publish the capture service and the first-frame slot on the host scope.
 * @param ctx - app-level context, never an agent preset's.
 * @param backend - unwrapped platform backend, so a lasso capture lists no observation frame.
 */
declare function installLassoServices(ctx: Context, backend: DesktopBackend): void;
/**
 * Mount the provider with the host platform backend.
 * The overlay guard belongs to the orb host in the same scope; it is read when a
 * capture starts, so this row may mount before or after that plugin.
 * @param ctx - app-level registration scope.
 */
declare function apply(ctx: Context): void;
//#endregion
export { apply, installLassoServices, name };