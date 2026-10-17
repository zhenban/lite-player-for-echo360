// Declarations for the type checker (npm run typecheck): what the page, the browser or
// the userscript manager provide that TypeScript's DOM types do not know.

declare const Hls: any;                 // hls.js when a development page provides it (otherwise platform.loadHls)
declare const GM_info: any;             // the userscript manager's script info
declare const GM_xmlhttpRequest: any;   // requests to the telemetry Worker (05-platform.js)
declare const GM_getValue: any;         // values kept by the userscript manager (the telemetry secret)
declare const GM_setValue: any;
declare const unsafeWindow: any;
declare const VERSION: string;          // set by build.mjs around the joined sources
declare const DEV_HOOKS: boolean;       // set by build.mjs: true only in the tests' builds
declare const webkitAudioContext: typeof AudioContext;

interface Window {
  Hls?: any;
  Echo?: any;                           // Echo360's page object (10-adapter-echo360.js)
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
  documentPictureInPicture?: { requestWindow(opts?: { width?: number; height?: number }): Promise<Window> };
  __litePlayerForEcho360DryRun?: object[];       // development: writes recorded instead of sent
  __litePlayerForEcho360?: object;         // development (debug on)
  __litePlayerForEcho360Dev?: object;            // development (debug on)
}

interface Navigator {
  connection?: { downlink?: number; saveData?: boolean };
}
