export const maximumRoomPoints = 64;

const epsilon = 1e-10;

function crossProduct([ax, ay], [bx, by], [cx, cy]) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function between(value, first, last) {
  return value >= Math.min(first, last) - epsilon && value <= Math.max(first, last) + epsilon;
}

function sideOf(a, b, point) {
  const cross = crossProduct(a, b, point);
  return Math.abs(cross) <= epsilon ? 0 : Math.sign(cross);
}

function edgesIntersect(a, b, c, d) {
  const sides = [sideOf(a, b, c), sideOf(a, b, d), sideOf(c, d, a), sideOf(c, d, b)];
  const onEdge = ([x, y], [ax, ay], [bx, by]) => between(x, ax, bx) && between(y, ay, by);
  return sides[0] * sides[1] < 0 && sides[2] * sides[3] < 0
    || sides[0] === 0 && onEdge(c, a, b)
    || sides[1] === 0 && onEdge(d, a, b)
    || sides[2] === 0 && onEdge(a, c, d)
    || sides[3] === 0 && onEdge(b, c, d);
}

export function roomPolygonError(points) {
  if (points.length < 3) return 'Add at least three corners.';
  if (points.length > maximumRoomPoints) return 'A room can have up to 64 corners.';
  if (new Set(points.map(point => point.join(','))).size !== points.length) return 'Use a different position for each corner.';
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const [x, y] = points[index];
    const [nextX, nextY] = points[(index + 1) % points.length];
    area += x * nextY - y * nextX;
    for (let next = index + 2; next < points.length; next++) {
      if (index === 0 && next === points.length - 1) continue;
      if (edgesIntersect(points[index], points[index + 1], points[next], points[(next + 1) % points.length])) {
        return 'Room edges cannot cross or touch other edges.';
      }
    }
  }
  return Math.abs(area) > epsilon ? '' : 'Spread the corners out to enclose an area.';
}

function edgeDistanceSquared([x, y], [[ax, ay], [bx, by]]) {
  const dx = bx - ax;
  const dy = by - ay;
  const along = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
  const t = Math.max(0, Math.min(1, along));
  return (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2;
}

export function roomLabelPosition(points) {
  const edges = points.map((point, index) => [point, points[(index + 1) % points.length]]);
  const heights = [...new Set(points.map(([, y]) => y))].sort((a, b) => a - b);
  let best = points[0];
  let clearance = -1;
  // Test scanlines between vertex heights. Alternating pairs of intersections lie inside the room.
  for (let index = 1; index < heights.length; index++) {
    const y = (heights[index - 1] + heights[index]) / 2;
    const intersections = [];
    for (const [[ax, ay], [bx, by]] of edges) {
      if ((ay > y) !== (by > y)) intersections.push(ax + (y - ay) * (bx - ax) / (by - ay));
    }
    intersections.sort((a, b) => a - b);
    for (let pair = 1; pair < intersections.length; pair += 2) {
      const point = [(intersections[pair - 1] + intersections[pair]) / 2, y];
      const distance = Math.min(...edges.map(edge => edgeDistanceSquared(point, edge)));
      if (distance > clearance) {
        best = point;
        clearance = distance;
      }
    }
  }
  return best;
}
