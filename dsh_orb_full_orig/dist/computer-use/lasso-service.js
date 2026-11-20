import { n as installLassoCapture, s as createPlatformBackend, t as createLassoSeedStore } from "./lasso-BVa38J49.js";
//#region src/lasso-service.ts
/** Cordis plugin name for the app-level provider row in `cordis.patch.yml`. */
const name = "computer-use-lasso";
/**
* Publish the capture service and the first-frame slot on the host scope.
* @param ctx - app-level context, never an agent preset's.
* @param backend - unwrapped platform backend, so a lasso capture lists no observation frame.
*/
function installLassoServices(ctx, backend) {
	ctx.provide("computerUseLassoCapture", installLassoCapture(ctx, backend));
	ctx.provide("computerUseLassoSeed", createLassoSeedStore());
}
/**
* Mount the provider with the host platform backend.
* The overlay guard belongs to the orb host in the same scope; it is read when a
* capture starts, so this row may mount before or after that plugin.
* @param ctx - app-level registration scope.
*/
function apply(ctx) {
	const excludedRegionCapture = (input) => {
		const capture = ctx.get("computerUseOverlayGuard")?.captureExcludedRegion;
		if (capture === void 0) return Promise.reject(/* @__PURE__ */ new Error("dsh desktop: overlay-exclude capture is not attached"));
		const { signal, ...region } = input;
		return capture(region, signal);
	};
	installLassoServices(ctx, createPlatformBackend(process.platform, excludedRegionCapture));
}
//#endregion
export { apply, installLassoServices, name };
