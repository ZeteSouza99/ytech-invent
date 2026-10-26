const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withShortAndroidPaths(config) {
  return withAppBuildGradle(config, result => {
    const marker = '// ytech-short-native-paths';
    const contents = result.modResults.contents;
    if (contents.includes(marker)) return result;
    if (result.modResults.language !== 'groovy' || !contents.includes('\nandroid {')) {
      throw new Error('Não foi possível configurar os caminhos CMake no build.gradle gerado.');
    }
    // Ninja on Windows rejects long object paths; keep staging local and let CMake hash source paths.
    result.modResults.contents = contents.replace('\nandroid {', `
android {
    ${marker}
    externalNativeBuild {
        cmake {
            buildStagingDirectory new File(rootProject.projectDir.parentFile, ".cxx")
        }
    }
    defaultConfig {
        externalNativeBuild {
            cmake {
                arguments "-DCMAKE_OBJECT_PATH_MAX=240"
            }
        }
    }`);
    return result;
  });
};
