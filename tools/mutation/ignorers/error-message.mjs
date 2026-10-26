// Stryker Ignore plugin `error-message` (67-04, D-04, D-20).
import { declareClassPlugin, PluginKind } from "@stryker-mutator/api/plugin";
import { shouldIgnoreErrorMessage } from "./error-message-rule.mjs";

class ErrorMessageIgnorer {
  shouldIgnore(path) {
    return shouldIgnoreErrorMessage(path);
  }
}

export const strykerPlugins = [
  declareClassPlugin(PluginKind.Ignore, "error-message", ErrorMessageIgnorer),
];
