export type Screen = 'home' | 'new' | 'edit' | 'inventory' | 'capture' | 'unit' | 'account' | 'review' | 'export';

export type Navigation = {
  screen: Screen;
  // Export of every inventory of the account (from Conta e dados) instead of the open one.
  exportAll: boolean;
  // Unit being edited on the 'unit' screen.
  unitId: string | null;
};

export type NavigationAction =
  | { type: 'go'; screen: Exclude<Screen, 'export' | 'unit'> }
  | { type: 'export'; all: boolean }
  | { type: 'unit'; id: string }
  | { type: 'back' };

export const initialNavigation: Navigation = { screen: 'home', exportAll: false, unitId: null };

// Where the Android back button and the "Voltar" buttons lead; null leaves the app.
export function backTarget(navigation: Navigation): Screen | null {
  switch (navigation.screen) {
    case 'home':
      return null;
    case 'export':
      return navigation.exportAll ? 'account' : 'inventory';
    case 'capture':
    case 'edit':
    case 'review':
    case 'unit':
      return 'inventory';
    default:
      return 'home';
  }
}

export function navigationReducer(state: Navigation, action: NavigationAction): Navigation {
  switch (action.type) {
    case 'go':
      return { ...state, screen: action.screen, unitId: null };
    case 'export':
      return { ...state, screen: 'export', exportAll: action.all, unitId: null };
    case 'unit':
      return { ...state, screen: 'unit', unitId: action.id };
    case 'back': {
      const target = backTarget(state);
      return target ? { ...state, screen: target, unitId: null } : state;
    }
  }
}
