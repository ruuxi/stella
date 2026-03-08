/**
 * iOS command execution - mirrors actions.ts but for iOS Safari via Appium.
 * Provides 1:1 command parity where possible.
 */

import type { IOSManager } from './ios-manager.js';
import type { Command, Response } from './types.js';

function successResponse<T>(id: string, data: T): Response<T> {
  return { id, success: true, data };
}

function errorResponse(id: string, error: string): Response {
  return { id, success: false, error };
}

/**
 * Execute a command on the iOS manager
 */
export async function executeIOSCommand(command: Command, manager: IOSManager): Promise<Response> {
  const { id } = command;

  try {
    switch (command.action) {
      case 'launch': {
        const device = 'device' in command ? command.device : undefined;
        const udid = 'udid' in command ? command.udid : undefined;
        await manager.launch({
          device: typeof device === 'string' ? device : undefined,
          udid: typeof udid === 'string' ? udid : undefined,
        });
        const info = manager.getDeviceInfo();
        return successResponse(id, {
          launched: true,
          device: info?.name ?? 'iOS Simulator',
          udid: info?.udid,
        });
      }

      case 'navigate': {
        const result = await manager.navigate(command.url);
        return successResponse(id, result);
      }

      case 'click': {
        await manager.click(command.selector);
        return successResponse(id, { clicked: true });
      }

      case 'tap': {
        await manager.tap(command.selector);
        return successResponse(id, { tapped: true });
      }

      case 'type': {
        await manager.type(command.selector, command.text, {
          delay: command.delay,
          clear: command.clear,
        });
        return successResponse(id, { typed: true });
      }

      case 'fill': {
        await manager.fill(command.selector, command.value);
        return successResponse(id, { filled: true });
      }

      case 'screenshot': {
        const result = await manager.screenshot({
          path: command.path,
          fullPage: command.fullPage,
        });
        return successResponse(id, result);
      }

      case 'snapshot': {
        const result = await manager.getSnapshot({
          interactive: command.interactive,
        });
        return successResponse(id, { snapshot: result.tree, refs: result.refs });
      }

      case 'scroll': {
        await manager.scroll({
          selector: command.selector,
          x: command.x,
          y: command.y,
          direction: command.direction,
          amount: command.amount,
        });
        return successResponse(id, { scrolled: true });
      }

      case 'swipe': {
        await manager.swipe(command.direction, { distance: command.distance });
        return successResponse(id, { swiped: true });
      }

      case 'evaluate': {
        const result = await manager.evaluate(command.script, ...(command.args ?? []));
        return successResponse(id, { result });
      }

      case 'wait': {
        await manager.wait({
          selector: command.selector,
          timeout: command.timeout,
          state: command.state,
        });
        return successResponse(id, { waited: true });
      }

      case 'press': {
        await manager.press(command.key);
        return successResponse(id, { pressed: true });
      }

      case 'hover': {
        await manager.hover(command.selector);
        return successResponse(id, { hovered: true });
      }

      case 'content': {
        const html = await manager.getContent(command.selector);
        return successResponse(id, { html });
      }

      case 'gettext': {
        const text = await manager.getText(command.selector);
        return successResponse(id, { text });
      }

      case 'getattribute': {
        const value = await manager.getAttribute(command.selector, command.attribute);
        return successResponse(id, { value });
      }

      case 'isvisible': {
        const visible = await manager.isVisible(command.selector);
        return successResponse(id, { visible });
      }

      case 'isenabled': {
        const enabled = await manager.isEnabled(command.selector);
        return successResponse(id, { enabled });
      }

      case 'url': {
        const url = await manager.getUrl();
        return successResponse(id, { url });
      }

      case 'title': {
        const title = await manager.getTitle();
        return successResponse(id, { title });
      }

      case 'back': {
        await manager.goBack();
        return successResponse(id, { navigated: 'back' });
      }

      case 'forward': {
        await manager.goForward();
        return successResponse(id, { navigated: 'forward' });
      }

      case 'reload': {
        await manager.reload();
        return successResponse(id, { reloaded: true });
      }

      case 'select': {
        await manager.select(command.selector, command.values);
        return successResponse(id, { selected: true });
      }

      case 'check': {
        await manager.check(command.selector);
        return successResponse(id, { checked: true });
      }

      case 'uncheck': {
        await manager.uncheck(command.selector);
        return successResponse(id, { unchecked: true });
      }

      case 'focus': {
        await manager.focus(command.selector);
        return successResponse(id, { focused: true });
      }

      case 'clear': {
        await manager.clear(command.selector);
        return successResponse(id, { cleared: true });
      }

      case 'count': {
        const count = await manager.count(command.selector);
        return successResponse(id, { count });
      }

      case 'boundingbox': {
        const box = await manager.getBoundingBox(command.selector);
        return successResponse(id, { box });
      }

      case 'close': {
        await manager.close();
        return successResponse(id, { closed: true });
      }

      // iOS-specific: device list
      case 'device_list': {
        const devices = await manager.listDevices();
        return successResponse(id, { devices });
      }

      // Commands that don't apply to iOS Safari
      case 'tab_new':
      case 'tab_list':
      case 'tab_switch':
      case 'tab_close':
      case 'window_new':
        return errorResponse(
          id,
          `Command '${command.action}' is not supported on iOS Safari. Mobile Safari does not support programmatic tab management.`
        );

      case 'pdf':
        return errorResponse(id, 'PDF generation is not supported on iOS Safari.');

      case 'screencast_start':
      case 'screencast_stop':
        return errorResponse(id, 'Screencast is not supported on iOS (requires CDP).');

      case 'recording_start':
      case 'recording_stop':
      case 'recording_restart':
        return errorResponse(id, 'Video recording is not yet supported on iOS.');

      default:
        return errorResponse(id, `Unknown or unsupported iOS command: ${command.action}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(id, message);
  }
}
