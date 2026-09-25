const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Browser preview only (`npx expo start --web`): expo-sqlite's web build needs wasm plus
// cross-origin isolation for SharedArrayBuffer. None of this touches Android builds.
config.resolver.assetExts.push('wasm');

const defaultGetTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (entryPoints, options, getDependenciesOf) => {
  const base = defaultGetTransformOptions
    ? await defaultGetTransformOptions(entryPoints, options, getDependenciesOf)
    : {};
  if (options.platform !== 'web') return base;
  return { ...base, transform: { ...base.transform, experimentalImportSupport: false, inlineRequires: false } };
};

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    return middleware(req, res, next);
  },
};

module.exports = config;
