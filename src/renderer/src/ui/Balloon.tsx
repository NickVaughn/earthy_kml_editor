import { useMemo } from 'react';
import type { KmlNode } from '@renderer/model/types';

interface Props {
  node: KmlNode;
  resources: Record<string, string>;
  onClose: () => void;
}

/**
 * Feature description popup. Untrusted KML HTML is rendered inside a sandboxed
 * iframe with NO script execution (PLAN §9). Relative image hrefs from a KMZ
 * archive are rewritten to their data: URLs.
 */
export function Balloon({ node, resources, onClose }: Props): JSX.Element {
  const srcDoc = useMemo(() => {
    let html = node.description ?? '<em>No description.</em>';
    // Rewrite KMZ-relative <img src="..."> to embedded data URLs.
    for (const [name, dataUrl] of Object.entries(resources)) {
      html = html.split(name).join(dataUrl);
    }
    const body = `<!doctype html><html><head><meta charset="utf-8">
      <style>
        body { font: 13px/1.5 -apple-system, sans-serif; color: #eee; margin: 8px; }
        a { color: #6cf; } img { max-width: 100%; height: auto; }
        table { border-collapse: collapse; } td, th { border: 1px solid #555; padding: 2px 6px; }
      </style></head><body>${html}</body></html>`;
    return body;
  }, [node.description, resources]);

  return (
    <div className="balloon">
      <div className="balloon-head">
        <span className="balloon-title">{node.name || '(unnamed)'}</span>
        <button className="balloon-close" onClick={onClose}>
          ✕
        </button>
      </div>
      <iframe
        title="description"
        className="balloon-frame"
        sandbox=""
        srcDoc={srcDoc}
      />
    </div>
  );
}
