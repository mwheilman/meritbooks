// Merit Workforce lives inside the Merit monorepo but is NOT an npm workspace (it keeps its own
// node_modules and lockfile so React Native never touches the web apps' installs). Resolve
// modules from this folder only, so Metro can never pick up the web apps' React from ../../.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [__dirname];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
