import { useMemo } from 'react';
import { Tree, type NodeRendererProps } from 'react-arborist';
import { useStore } from '@renderer/state/store';
import type { KmlNode } from '@renderer/model/types';

interface Props {
  onFlyTo: (id: string) => void;
  onOpenBalloon: (id: string) => void;
}

const ICON: Record<string, string> = {
  Document: '🗂',
  Folder: '📁',
  Placemark: '📍',
  GroundOverlay: '🖼',
  ScreenOverlay: '🖼',
  NetworkLink: '🔗',
  Unknown: '❓',
};

function geometryIcon(node: KmlNode): string {
  if (node.type !== 'Placemark' || !node.geometry) return ICON[node.type] ?? '•';
  switch (node.geometry.kind) {
    case 'Point':
      return '📍';
    case 'LineString':
      return '➰';
    case 'Polygon':
      return '⬡';
    case 'MultiGeometry':
      return '❖';
  }
}

function Row({ node, style, dragHandle }: NodeRendererProps<KmlNode>): JSX.Element {
  const data = node.data;
  const selection = useStore((s) => s.selection);
  const toggleVisibility = useStore((s) => s.toggleVisibility);
  const isSelected = selection.includes(data.id);

  return (
    <div
      className={`tree-row${isSelected ? ' selected' : ''}`}
      style={style}
      ref={dragHandle}
    >
      <span
        className="twisty"
        onClick={(e) => {
          e.stopPropagation();
          if (!node.isLeaf) node.toggle();
        }}
      >
        {node.isLeaf ? '' : node.isOpen ? '▾' : '▸'}
      </span>
      <input
        type="checkbox"
        checked={data.visible}
        onChange={(e) => {
          e.stopPropagation();
          toggleVisibility(data.id);
        }}
        onClick={(e) => e.stopPropagation()}
        title="Visibility"
      />
      <span className="tree-icon">{geometryIcon(data)}</span>
      <span className="tree-name">{data.name || <em>(unnamed)</em>}</span>
    </div>
  );
}

export function TreePanel({ onFlyTo, onOpenBalloon }: Props): JSX.Element {
  const doc = useStore((s) => s.doc);
  const revision = useStore((s) => s.revision);
  const setSelection = useStore((s) => s.setSelection);

  // Recompute the root list when the document or its structure changes.
  const data = useMemo(() => [doc.root], [doc, revision]);

  return (
    <Tree<KmlNode>
      data={data}
      idAccessor="id"
      childrenAccessor={(n) => (n.type === 'Placemark' ? null : n.children)}
      openByDefault
      width="100%"
      height={window.innerHeight - 84}
      rowHeight={26}
      indent={16}
      onSelect={(nodes) => setSelection(nodes.map((n) => n.data.id))}
      onActivate={(node) => {
        // Double-click / Enter: fly to and open balloon.
        onFlyTo(node.data.id);
        if (node.data.type === 'Placemark') onOpenBalloon(node.data.id);
      }}
    >
      {Row}
    </Tree>
  );
}
