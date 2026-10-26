import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Ytech Invent',
  slug: 'ytech-invent',
  version: '1.1.2',
  orientation: 'portrait',
  platforms: ['android'],
  scheme: 'ytechinvent',
  userInterfaceStyle: 'light',
  android: {
    package: 'com.ytechsolucoes.invent',
    versionCode: 4,
    allowBackup: false,
    permissions: ['CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
  },
  plugins: [
    './plugins/with-short-android-paths.cjs',
    ['expo-camera', { cameraPermission: 'Permitir leitura das etiquetas de inventário.', recordAudioAndroid: false }],
    'expo-sqlite',
    'expo-secure-store',
    'expo-asset',
  ],
};

export default config;
