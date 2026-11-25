// 相机仪器坐标系：ENU 基底下的前/右/上向量，gnomonic 投影 <-> 像素
import type { CameraSpec } from '../core/types';
import { azAltToEnu, D2R } from '../geo/astro';

export interface CameraRig {
  cam: CameraSpec;
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}

function rotVecByAxis(
  v: [number, number, number],
  axis: [number, number, number],
  angRad: number,
): [number, number, number] {
  // Rodrigues
  const c = Math.cos(angRad), s = Math.sin(angRad);
  const dot = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const cx: [number, number, number] = [
    axis[1] * v[2] - axis[2] * v[1],
    axis[2] * v[0] - axis[0] * v[2],
    axis[0] * v[1] - axis[1] * v[0],
  ];
  return [
    v[0] * c + cx[0] * s + axis[0] * dot * (1 - c),
    v[1] * c + cx[1] * s + axis[1] * dot * (1 - c),
    v[2] * c + cx[2] * s + axis[2] * dot * (1 - c),
  ];
}

export function createRig(cam: CameraSpec): CameraRig {
  const forward = azAltToEnu(cam.az, cam.alt);
  // right = normalize(cross(forward, zenith))
  let right: [number, number, number] = [forward[1], -forward[0], 0];
  const rn = Math.hypot(right[0], right[1], right[2]);
  right = [right[0] / rn, right[1] / rn, right[2] / rn];
  // up = cross(right, forward)
  let up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const un = Math.hypot(up[0], up[1], up[2]);
  up = [up[0] / un, up[1] / un, up[2] / un];
  if (cam.roll) {
    const r = cam.roll * D2R;
    right = rotVecByAxis(right, forward, r);
    up = rotVecByAxis(up, forward, r);
  }
  return { cam, forward, right, up };
}

export interface PixelXY { x: number; y: number }

/** ENU 单位向量 -> 像素；在视平面之后返回 null */
export function projectEnu(rig: CameraRig, v: [number, number, number]): PixelXY | null {
  const z = v[0] * rig.forward[0] + v[1] * rig.forward[1] + v[2] * rig.forward[2];
  if (z <= 0.02) return null;
  const xc = v[0] * rig.right[0] + v[1] * rig.right[1] + v[2] * rig.right[2];
  const yc = v[0] * rig.up[0] + v[1] * rig.up[1] + v[2] * rig.up[2];
  const nx = xc / z;
  const ny = yc / z;
  return { x: rig.cam.cx + rig.cam.fx * nx, y: rig.cam.cy - rig.cam.fy * ny };
}

/** 像素 -> ENU 单位射线（理想相机模型；标定解算后应改用 PlateSolution 仿射） */
export function pixelToEnuRayIdeal(rig: CameraRig, x: number, y: number): [number, number, number] {
  const nx = (x - rig.cam.cx) / rig.cam.fx;
  const ny = -(y - rig.cam.cy) / rig.cam.fy;
  let v: [number, number, number] = [
    nx * rig.right[0] + ny * rig.up[0] + rig.forward[0],
    nx * rig.right[1] + ny * rig.up[1] + rig.forward[1],
    nx * rig.right[2] + ny * rig.up[2] + rig.forward[2],
  ];
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function fovDeg(cam: CameraSpec) {
  return {
    h: (2 * Math.atan(cam.width / 2 / cam.fx) * 180) / Math.PI,
    v: (2 * Math.atan(cam.height / 2 / cam.fy) * 180) / Math.PI,
  };
}
