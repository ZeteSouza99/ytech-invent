import type { ExpoConfig } from 'expo/config';
import packageJson from './package.json';

const config: ExpoConfig = {
  name: 'Ytech Invent',
  slug: 'ytech-invent',
  // Single source for the visible version; scripts/build-apk.ps1 refuses to build when android/ disagrees.
  version: packageJson.version,
  orientation: 'portrait',
  platforms: ['android'],
  scheme: 'ytechinvent',
  userInterfaceStyle: 'light',
  android: {
    package: 'com.ytechsolucoes.invent',
    // Must grow with every APK distributed; Android refuses to install an update with the same or a lower code.
    versionCode: 4,
    allowBackup: false,
    permissions: ['CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
  },
  plugins: [
    './plugins/with-short-android-paths.cjs',
    './plugins/with-release-signing.cjs',
    ['expo-camera', { cameraPermission: 'Permitir leitura das etiquetas de inventário.', recordAudioAndroid: false }],
    ['expo-sqlite', { useSQLCipher: true }],
    'expo-secure-store',
    'expo-asset',
    'expo-background-task',
  ],
};

export default config;
