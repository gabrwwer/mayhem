import { useEffect, useState } from 'react';
import { api } from '../api/client';

export function RejectionsPanel(): JSX.Element {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const r = await api.getRejections();
        if (mounted) setItems(Array.isArray(r) ? r : []);
      } catch {
        if (mounted) setItems([]);
      }
    }

    load();
    const id = setInterval(load, 5000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  return (
    <details style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
      <summary style={{ cursor: 'pointer', marginBottom: 8 }}>Recent Rejections</summary>
      <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
        {items.length === 0 && <div style={{ color: 'var(--text-mute)' }}>No recent rejections</div>}
        {items.map((it, idx) => (
          <pre key={idx} style={{ background: 'var(--panel)', padding: 8, marginBottom: 6 }}>{JSON.stringify(it, null, 2)}</pre>
        ))}
      </div>
    </details>
  );
}

export default RejectionsPanel;
