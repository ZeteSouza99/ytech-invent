const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// ytech-release-signing';
const RELEASE_CONFIG = `signingConfigs {
        ${MARKER}
        // Used only when scripts/build-apk.ps1 -ReleaseKey passes the private key; otherwise the debug key signs.
        release {
            def releaseStore = System.getenv('YTECH_RELEASE_STORE_FILE')
            if (releaseStore) {
                storeFile file(releaseStore)
                storePassword System.getenv('YTECH_RELEASE_STORE_PASSWORD')
                keyAlias System.getenv('YTECH_RELEASE_KEY_ALIAS')
                keyPassword System.getenv('YTECH_RELEASE_KEY_PASSWORD')
            }
        }`;
const RELEASE_TYPE = /(buildTypes\s*\{[\s\S]*?\n\s*release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;

function applyReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;
  if (!contents.includes('signingConfigs {') || !RELEASE_TYPE.test(contents)) {
    throw new Error('Não foi possível configurar a assinatura release no build.gradle gerado.');
  }
  return contents
    .replace('signingConfigs {', RELEASE_CONFIG)
    .replace(RELEASE_TYPE, "$1signingConfig System.getenv('YTECH_RELEASE_STORE_FILE') ? signingConfigs.release : signingConfigs.debug");
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, result => {
    if (result.modResults.language !== 'groovy') throw new Error('O build.gradle do app deveria ser Groovy.');
    result.modResults.contents = applyReleaseSigning(result.modResults.contents);
    return result;
  });
};
module.exports.applyReleaseSigning = applyReleaseSigning;
