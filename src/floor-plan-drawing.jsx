import React, {useEffect, useState} from 'react';
import {maximumRoomPoints, roomPolygonError} from './floor-plan-polygon.mjs';
import './floor-plan-drawing.css';

const centre = [.5, .5];
const directions = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
const clamp = value => Math.max(0, Math.min(1, value));

export function useRoomDrawingStage({active, stage, position, onPoint, onUndo, onCancel}) {
  const [cursor, setCursor] = useState(null);
  useEffect(() => {
    if (active) stage.current?.focus({preventScroll: true});
    else setCursor(null);
  }, [active, stage]);

  if (!active) return {cursor: null, stageProps: {}};
  return {
    cursor,
    stageProps: {
      role: 'group',
      tabIndex: 0,
      'aria-label': 'Room drawing canvas. Arrow keys move the crosshair. Enter adds a corner.',
      onPointerMove: event => {
        if (event.pointerType !== 'touch') setCursor(position(event));
      },
      onPointerLeave: () => setCursor(null),
      onKeyDown: event => {
        if (event.target !== event.currentTarget) return;
        const direction = directions[event.key];
        if (direction) {
          const step = event.shiftKey ? .05 : .01;
          event.preventDefault();
          setCursor(previous => (previous || centre).map((value, index) => clamp(value + direction[index] * step)));
          return;
        }
        if (!['Enter', ' ', 'Backspace', 'Delete', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (event.key === 'Escape') onCancel();
        else if (event.key === 'Backspace' || event.key === 'Delete') onUndo();
        else onPoint(cursor || centre);
      },
    },
  };
}

export function RoomDrawingControls({points, redrawing, onUndo, onCancel, onFinish}) {
  const error = roomPolygonError(points);
  return <div className="floor-place-instruction floor-drawing-controls">
    <span>
      <strong>{redrawing ? 'Redraw room' : 'Draw a room'}</strong>
      <small>Tap each corner around the room. Use the arrow keys and Enter to add corners by keyboard.</small>
      <small role="status">{points.length} {points.length === 1 ? 'corner' : 'corners'}{points.length === maximumRoomPoints ? ' · Corner limit reached' : ''}{error ? ` · ${error}` : ''}</small>
    </span>
    <button type="button" disabled={!points.length} onClick={onUndo}>Undo corner</button>
    <button type="button" onClick={onCancel}>Cancel drawing</button>
    <button type="button" className="primary" disabled={!!error} onClick={onFinish}>Finish room</button>
  </div>;
}

export function RoomDrawingPreview({floor, points, cursor}) {
  const toMap = ([x, y]) => `${x * floor.width},${y * floor.height}`;
  const outline = points.map(toMap).join(' ');
  const tail = points.at(-1);
  return <div className="floor-drawing-preview" aria-hidden="true">
    <svg className="floor-geometry" viewBox={`0 0 ${floor.width} ${floor.height}`} preserveAspectRatio="none">
      {points.length >= 3 ? <polygon className="floor-drawing-fill" points={outline}/> : null}
      <polyline className="floor-drawing-outline" points={outline} vectorEffect="non-scaling-stroke"/>
      {tail && cursor ? <polyline className="floor-drawing-guide" points={`${toMap(tail)} ${toMap(cursor)}`} vectorEffect="non-scaling-stroke"/> : null}
    </svg>
    {points.map(([x, y], index) => <span key={index} className="floor-drawing-corner" style={{left: `${x * 100}%`, top: `${y * 100}%`}}/>)}
    {cursor ? <span className="floor-drawing-crosshair" style={{left: `${cursor[0] * 100}%`, top: `${cursor[1] * 100}%`}}/> : null}
  </div>;
}
