const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// The SB1 template ships inside the app so the catalog and the exports work offline.
config.resolver.assetExts.push('xlsx');

// The default browser build bundles core-js polyfills that overflow Hermes' native stack.
const excelJsBare = path.join(__dirname, 'node_modules', 'exceljs', 'dist', 'exceljs.bare.min.js');
config.resolver.resolveRequest = (context, moduleName, platform) => moduleName === 'exceljs'
  ? { type: 'sourceFile', filePath: excelJsBare }
  : context.resolveRequest(context, moduleName, platform);

module.exports = config;
