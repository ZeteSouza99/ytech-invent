import { registerRootComponent } from 'expo';
// Defines the background sending task before anything else: Android may start the app only to run it.
import './src/backgroundSend';
import App from './App';

registerRootComponent(App);
