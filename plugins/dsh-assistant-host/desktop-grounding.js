import { sameScene } from './task-watch.js';
import { eligibleWindow, windowAtPoint } from './vendor/orb/vision/eligibility.js';

export { eligibleWindow } from './vendor/orb/vision/eligibility.js';

export function guidanceScope(task, excludePids = []) {
  const window = task?.target_window;
  return window
    ? {kind:'window',foregroundWindow:true,hwnd:window.hwnd,pid:window.pid,
        scope_id:'guidance-window',excludePids}
    : {kind:'monitor',monitor:0,desktopWindows:true,scope_id:'guidance-desktop',excludePids};
}

export function selectVisualWindow(frame, visual) {
  // The visible target point is the authority. Orb-style eligibility filters
  // the candidate window; optional old window points are not needed.
  const target = windowAtPoint(frame.windows, visual.targetPoint);
  if (!target) {
    throw Error('目标位置被桌面、系统悬浮层或其他不可操作窗口遮挡；请让目标软件完整可见后重试。');
  }
  return target;
}

export function cropWindow(frame, window) {
  const b=frame.bounds, r=window.rect;
  const left=Math.max(b.left,r[0]),top=Math.max(b.top,r[1]);
  const width=Math.min(b.left+b.width,r[2])-left, height=Math.min(b.top+b.height,r[3])-top;
  if (!frame.raw || width<=0 || height<=0) throw Error('目标窗口不在截图范围内');
  const raw=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++) {
    const offset=((top-b.top+y)*frame.width+left-b.left)*3;
    frame.raw.copy(raw,y*width*3,offset,offset+width*3);
  }
  return {raw,width,height,bounds:{left,top,width,height},target_window:{...window,foreground:window.hwnd,
    window_geometry:[{hwnd:window.hwnd,rect:[...window.rect]}]},
    captured_at:frame.captured_at,frame_id:frame.frame_id,geometry_revision:frame.geometry_revision};
}

export function confirmVisualWindow(before, after, visual) {
  const previous=selectVisualWindow(before,visual), current=selectVisualWindow(after,visual);
  if(previous.hwnd!==current.hwnd || previous.pid!==current.pid
      || JSON.stringify(previous.rect)!==JSON.stringify(current.rect)) {
    throw Error('目标窗口在识别期间移动或发生切换，请重新指导。');
  }
  const oldCrop=cropWindow(before,previous), newCrop=cropWindow(after,current);
  if(!sameScene(oldCrop,newCrop)) {
    throw Error(`目标窗口画面已变化（hwnd=${previous.hwnd}`
      + `${previous.class_name ? `, class=${previous.class_name}` : ''}），请重新指导。`);
  }
  return {binding:newCrop.target_window,baseline:newCrop};
}
