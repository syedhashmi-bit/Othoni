// Settings page layout: tabs, and the cards (sections) inside each. Shared
// by the Settings page and the command palette so `/settings#peers` style
// deep links resolve the same way in both. A hash may name a tab or a
// section; a section hash opens its tab and scrolls to the card.

export const SETTINGS_TABS = [
  {
    id: 'general',
    label: 'General',
    sections: [
      { id: 'preferences', label: 'Preferences', keywords: 'refresh interval density theme light dark' },
      { id: 'server', label: 'Session & server', keywords: 'version hostname port node_env' },
    ],
  },
  {
    id: 'fleet',
    label: 'Fleet',
    sections: [
      { id: 'hosts', label: 'Hosts', keywords: 'agent location metadata owner environment tags' },
      { id: 'peers', label: 'Federated peers', keywords: 'federation wireguard token remote' },
    ],
  },
  {
    id: 'access',
    label: 'Access',
    sections: [
      { id: 'sign-in', label: 'Google sign-in', keywords: 'users accounts google email allowlist viewer admin login' },
      { id: 'sessions', label: 'Sessions', keywords: 'logins revoke devices' },
      { id: 'api-keys', label: 'API keys', keywords: 'agent ingest metrics token' },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    sections: [
      { id: 'storage', label: 'Storage', keywords: 'sqlite database vacuum export size' },
      { id: 'retention', label: 'Retention overrides', keywords: 'history keep days' },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    sections: [
      { id: 'actions', label: 'Actions', keywords: 'remediate restart write' },
      { id: 'audit-log', label: 'Audit log', keywords: 'events who changed' },
    ],
  },
];

// Map a location hash (with or without '#') to { tab, section }.
export function resolveSettingsHash(hash) {
  const id = (hash || '').replace(/^#/, '');
  for (const t of SETTINGS_TABS) {
    if (t.id === id) return { tab: t.id, section: null };
    if (t.sections.some((s) => s.id === id)) return { tab: t.id, section: id };
  }
  return { tab: SETTINGS_TABS[0].id, section: null };
}
