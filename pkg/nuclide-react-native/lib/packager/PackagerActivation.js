'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {OutputService} from '../../../nuclide-console/lib/types';
import type {CwdApi} from '../../../nuclide-current-working-directory/lib/CwdApi';
import type {PackagerEvent} from './types';

// eslint-disable-next-line nuclide-internal/no-cross-atom-imports
import {LogTailer} from '../../../nuclide-console/lib/LogTailer';
import {getCommandInfo} from '../../../nuclide-react-native-base';
import {observeProcess, safeSpawn, exitEventToMessage} from '../../../commons-node/process';
import {parseMessages} from './parseMessages';
import {CompositeDisposable, Disposable} from 'atom';
import invariant from 'assert';
import {Observable} from 'rxjs';

/**
 * Runs the server in the appropriate place. This class encapsulates all the state of the packager
 * so as to keep the Activation class (which brings together various RN features) clean.
 */
export class PackagerActivation {
  _logTailer: LogTailer;
  _projectRootPath: ?string;
  _disposables: CompositeDisposable;

  constructor() {
    const packagerEvents = Observable.defer(
      () => getPackagerObservable(this._projectRootPath),
    )
      .share();
    const messages = packagerEvents
      .filter(event => event.kind === 'message')
      .map(event => {
        invariant(event.kind === 'message');
        return event.message;
      });
    const ready = packagerEvents
      .filter(message => message.kind === 'ready')
      .mapTo(undefined);
    this._logTailer = new LogTailer({
      name: 'React Native Packager',
      messages,
      ready,
      handleError(err) {
        switch (err.name) {
          case 'NoReactNativeProjectError':
            // If a React Native project hasn't been found, notify the user and complete normally.
            atom.notifications.addError("Couldn't find a React Native project", {
              dismissable: true,
              description:
                'Make sure that your current working root (or its ancestor) contains a' +
                ' "node_modules" directory with react-native installed, or a .buckconfig file' +
                ' with a "[react-native]" section that has a "server" key.',
            });
            return;
          case 'PackagerError':
            invariant(err instanceof PackagerError);
            atom.notifications.addError(
              `Packager exited with ${err.exitMessage}`, {
                dismissable: true,
                detail: err.stderr.trim() === '' ? undefined : err.stderr,
              },
            );
            return;
        }
        throw err;
      },
      trackingEvents: {
        start: 'react-native-packager:start',
        stop: 'react-native-packager:stop',
        restart: 'react-native-packager:restart',
      },
    });

    this._disposables = new CompositeDisposable(
      new Disposable(() => { this._logTailer.stop(); }),
      atom.commands.add('atom-workspace', {
        'nuclide-react-native:start-packager': event => {
          // $FlowFixMe
          const detail = event.detail != null && typeof event.detail === 'object'
            ? event.detail
            : undefined;
          this._logTailer.start(detail);
        },
        'nuclide-react-native:stop-packager': () => this._logTailer.stop(),
        'nuclide-react-native:restart-packager': () => this._logTailer.restart(),
      }),
    );
  }

  dispose(): void {
    this._disposables.dispose();
  }

  consumeCwdApi(api: CwdApi): void {
    this._disposables.add(
      api.observeCwd(dir => {
        this._projectRootPath = dir == null ? null : dir.getPath();
      }),
    );
  }

  consumeOutputService(api: OutputService): void {
    this._disposables.add(
      api.registerOutputProvider({
        id: 'React Native Packager',
        messages: this._logTailer.getMessages(),
        observeStatus: cb => this._logTailer.observeStatus(cb),
        start: () => { this._logTailer.start(); },
        stop: () => { this._logTailer.stop(); },
      }),
    );
  }

}

class NoReactNativeProjectError extends Error {
  constructor() {
    // TODO: Remove `captureStackTrace()` call and `this.message` assignment when we remove our
    // class transform and switch to native classes.
    const message = 'No React Native Project found';
    super(message);
    this.name = 'NoReactNativeProjectError';
    this.message = message;
    Error.captureStackTrace(this, this.constructor);
  }
}

class PackagerError extends Error {
  exitMessage: string;
  stderr: string;
  constructor(exitMessage: string, stderr: string) {
    // TODO: Remove `captureStackTrace()` call and `this.message` assignment when we remove our
    // class transform and switch to native classes.
    const message = 'An error occurred while running the packager';
    super(message);
    this.name = 'PackagerError';
    this.message = message;
    this.exitMessage = exitMessage;
    this.stderr = stderr;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Create an observable that runs the packager and and collects its output.
 */
function getPackagerObservable(projectRootPath: ?string): Observable<PackagerEvent> {
  const stdout = Observable.fromPromise(getCommandInfo(projectRootPath))
    .switchMap(commandInfo => (
      commandInfo == null
        ? Observable.throw(new NoReactNativeProjectError())
        : Observable.of(commandInfo)
    ))
    .switchMap(commandInfo => {
      const {command, cwd, args} = commandInfo;
      return observeProcess(() => safeSpawn(command, args, {cwd}));
    })
    // Accumulate the stderr so that we can show it to the user if something goes wrong.
    .scan(
      (acc, event) => {
        return {
          stderr: event.kind === 'stderr' ? acc.stderr + event.data : acc.stderr,
          event,
        };
      },
      {stderr: '', event: null},
    )
    .switchMap(({stderr, event}) => {
      if (event == null) { return Observable.empty(); }
      switch (event.kind) {
        case 'error':
          return Observable.throw(event.error);
        case 'stdout':
          return Observable.of(event.data);
        case 'exit':
          if (event.exitCode !== 0) {
            return Observable.throw(new PackagerError(exitEventToMessage(event), stderr));
          }
          return Observable.empty();
        case 'stderr':
        default:
          // We just ignore these.
          return Observable.empty();
      }
    });

  return parseMessages(stdout);
}
