import { Component, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Button, styles } from './ui';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <View style={[styles.screen, styles.content, { justifyContent: 'center' }]}>
      <Text style={styles.heading}>Não foi possível abrir esta tela</Text>
      <Text style={styles.body}>As unidades já salvas continuam no aparelho. Feche e reabra o aplicativo para retomar a coleta. Não limpe os dados nem desinstale.</Text>
      <Button title="Tentar abrir novamente" onPress={() => this.setState({ failed: false })} />
    </View>;
  }
}
