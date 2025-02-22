/* eslint @typescript-eslint/no-this-alias: 0 */
/* eslint prefer-rest-params: 0 */
/* eslint @typescript-eslint/no-explicit-any: 0 */
import * as events from "./events";

import { StorageProvider, Source, Destination } from "../storage";
import { Callable, logger } from "../utils";
import { NetworkNode } from "../network";

export class CommandContainer {
  private _commands;

  constructor() {
    this._commands = [];
    return new Proxy(this, this.getattr());
  }

  commands() {
    return this._commands;
  }

  getattr() {
    const self = this;
    return {
      get(target, name) {
        if (target[name] !== undefined) {
          return target[name];
        }
        const newFunction = function () {
          let _arguments = {};
          const args = arguments[0] || {};
          for (const [key, value] of Object.entries(args)) {
            _arguments = {
              ..._arguments,
              [key.startsWith("_") ? key.slice(1) : key]: value,
            };
          }
          const idx = self._commands.length;
          self._commands.push({ [name]: _arguments });
          return idx;
        };
        return new Proxy(newFunction, {
          apply: function (target, thisArg, argumentsList) {
            return target.apply(thisArg, argumentsList as []);
          },
        });
      },
    };
  }
}

export abstract class Work {
  public output: object[] = [];
  public attestation?: object;

  async prepare() {
    // Executes before commands are send to provider.
  }

  register(commands: CommandContainer) {
    // A hook which adds the required command to the exescript.
  }

  async post() {
    // A hook to be executed on requestor's end after the script has finished.
  }

  timeout() {
    return null;
  }
}

class _InitStep extends Work {
  constructor(private network_node?: NetworkNode) {
    super();
  }

  register(commands: any) {
    //CommandContainer
    commands.deploy(this.network_node ? this.network_node.get_deploy_args() : undefined);
    commands.start();
  }
}

class _SendWork extends Work {
  private _storage: StorageProvider;
  private _dst_path: string;
  private _src?: Source | null;
  private _idx: number | null;

  constructor(storage: StorageProvider, dst_path: string) {
    super();
    this._storage = storage;
    this._dst_path = dst_path;
    this._src = null;
    this._idx = null;
  }

  async do_upload(storage: StorageProvider): Promise<Source> {
    return new Promise((resolve) => resolve(new Source())); //TODO check this
  }

  async prepare(): Promise<void> {
    this._src = await this.do_upload(this._storage);
  }

  register(commands: any) {
    //CommandContainer
    if (!this._src) throw "cmd prepared";
    this._idx = commands.transfer({
      _from: this._src.download_url(),
      _to: `container:${this._dst_path}`,
      _args: {},
    });
  }
}

class _SendJson extends _SendWork {
  private _cnt: number;
  private _data: Buffer | null;

  constructor(storage: StorageProvider, data: unknown, dst_path: string) {
    super(storage, dst_path);
    this._cnt = 0;
    this._data = Buffer.from(JSON.stringify(data), "utf-8"); //Optional[bytes]
  }

  async do_upload(storage: StorageProvider): Promise<Source> {
    this._cnt += 1;
    if (!this._data) throw `json buffer unintialized ${this._cnt}`;
    const src = await storage.upload_bytes(this._data);
    this._data = null;
    return src;
  }
}

class _SendFile extends _SendWork {
  private _src_path: string;

  constructor(storage: StorageProvider, src_path: string, dst_path: string) {
    super(storage, dst_path);
    this._src_path = src_path;
  }

  async do_upload(storage: StorageProvider): Promise<Source> {
    return await storage.upload_file(this._src_path);
  }
}

class _Run extends Work {
  private cmd;
  private args;
  private env;
  private _idx;
  private _stdout?: CaptureContext;
  private _stderr?: CaptureContext;

  constructor(
    cmd: string,
    args: Iterable<string> = [],
    env: unknown | null = null,
    stdout?: CaptureContext,
    stderr?: CaptureContext
  ) {
    super();
    this.cmd = cmd;
    this.args = args;
    this.env = env;
    this._idx = null;
    this._stdout = stdout;
    this._stderr = stderr;
  }

  register(commands: any) {
    const capture = {};
    if (this._stdout) capture["stdout"] = this._stdout.to_dict();
    if (this._stderr) capture["stderr"] = this._stderr.to_dict();
    //CommandContainer
    this._idx = commands.run({
      entry_point: this.cmd,
      args: this.args || [],
      capture,
    });
  }
}

class _Sign extends Work {
  private _idx;

  constructor() {
    super();
    this._idx = null;
  }

  register(commands: any) {
    //CommandContainer
    this._idx = commands.sign({});
  }
}

const StorageEvent = events.DownloadStarted || events.DownloadFinished;

class _RecvFile extends Work {
  private _storage;
  private _dst_path;
  private _src_path!: string;
  private _dst_slot: Destination | null;
  private _idx: number | null;
  private _emitter?: Callable<[StorageEvent], void> | null = null;

  constructor(
    storage: StorageProvider,
    src_path: string,
    dst_path: string,
    emitter: Callable<[StorageEvent], void> | null = null
  ) {
    super();
    this._storage = storage;
    this._dst_path = dst_path;
    this._src_path = src_path;
    this._dst_slot = null;
    this._idx = null;
    this._emitter = emitter;
  }

  async prepare() {
    this._dst_slot = await this._storage.new_destination(this._dst_path);
  }

  register(commands: any) {
    //CommandContainer
    if (!this._dst_slot) throw "_RecvFile command creation without prepare";
    this._idx = commands.transfer({
      _from: `container:${this._src_path}`,
      _to: this._dst_slot!.upload_url(),
    });
  }

  async post(): Promise<void> {
    if (!this._dst_slot) throw "_RecvFile post without prepare";
    if (this._emitter) {
      this._emitter(new events.DownloadStarted({ path: this._src_path }));
    }
    await this._dst_slot.download_file(this._dst_path);
    if (this._emitter) {
      this._emitter(new events.DownloadFinished({ path: this._dst_path }));
    }
  }
}

class _Steps extends Work {
  private _steps: Work[] = [];
  private _timeout?: number;

  constructor(steps: Work | Work[], timeout?: number) {
    super();
    if (steps instanceof Work) this._steps.push(steps);
    else steps.forEach((step) => this._steps.push(step));
    this._timeout = timeout;
  }

  timeout(): any {
    return this._timeout;
  }

  // Execute the `prepare` hook for all the defined steps.
  async prepare() {
    for (const step of this._steps) {
      await step.prepare();
    }
  }

  // Execute the `register` hook for all the defined steps.
  register(commands: CommandContainer) {
    for (const step of this._steps) {
      step.register(commands);
    }
  }

  // Execute the `post` step for all the defined steps.
  async post() {
    for (const step of this._steps) {
      await step.post();
    }
  }
}

export class ExecOptions {
  wait_for_results = true;
  batch_timeout?: number | null;
}

/**
 * An object used to schedule commands to be sent to provider.
 */
export class WorkContext {
  private _id;
  private _storage: StorageProvider;
  private _pending_steps: Work[];
  private _started: boolean;
  private _emitter: Callable<[StorageEvent], void> | null;
  private _network_node?: NetworkNode;
  public provider_info: { provider_id: string; provider_name: string };

  constructor(
    ctx_id: string,
    storage: StorageProvider,
    emitter: Callable<[StorageEvent], void> | null = null,
    provider_info: { provider_id: string; provider_name: string },
    network_node?: NetworkNode
  ) {
    this._id = ctx_id;
    this._storage = storage;
    this._pending_steps = [];
    this._started = false;
    this._emitter = emitter;
    this._network_node = network_node;
    this.provider_info = provider_info;
  }

  get network_node() {
    if (!this._network_node) throw "There is no network node";
    return this._network_node;
  }

  _prepare() {
    if (!this._started) {
      this._pending_steps.push(new _InitStep(this._network_node));
      this._started = true;
    }
  }

  begin() {
    // abstract
  }

  /**
   * Schedule sending JSON data to the provider.
   *
   * @param json_path  remote (provider) path
   * @param data       object representing JSON data
   */
  send_json(json_path: string, data: unknown) {
    this._prepare();
    this._pending_steps.push(new _SendJson(this._storage, data, json_path));
  }

  /**
   * Schedule sending file to the provider.
   *
   * @param src_path local (requestor) path
   * @param dst_path remote (provider) path
   */
  send_file(src_path: string, dst_path: string) {
    this._prepare();
    this._pending_steps.push(new _SendFile(this._storage, src_path, dst_path));
  }

  /**
   * Schedule running a command.
   *
   * @param cmd   command to run on the provider, e.g. /my/dir/run.sh
   * @param args  command arguments, e.g. "input1.txt", "output1.txt"
   * @param env   optional object with environmental variables
   */
  run(cmd: string, args?: Iterable<string>, env: object | null = null) {
    const stdout = CaptureContext.build("all");
    const stderr = CaptureContext.build("all");
    this._prepare();
    this._pending_steps.push(new _Run(cmd, args, env, stdout, stderr));
  }

  /**
   * Schedule downloading remote file from the provider.
   *
   * @param src_path  remote (provider) path
   * @param dst_path  local (requestor) path
   */
  download_file(src_path: string, dst_path: string) {
    this._prepare();
    this._pending_steps.push(new _RecvFile(this._storage, src_path, dst_path, this._emitter));
  }

  sign() {
    this._prepare();
    this._pending_steps.push(new _Sign());
  }

  log(args) {
    logger.info(`${this._id}: ${args}`);
  }

  /**
   * Creates sequence of commands to be sent to provider.
   *
   * @returns Work object (the latter contains sequence commands added before calling this method)
   */
  commit({ timeout }: { timeout?: number } = {}): Work {
    const steps = this._pending_steps;
    this._pending_steps = [];
    return new _Steps(steps, timeout);
  }
}

enum CaptureMode {
  HEAD = "head",
  TAIL = "tail",
  HEAD_TAIL = "headTail",
  STREAM = "stream",
}

enum CaptureFormat {
  BIN = "bin",
  STR = "str",
}

class CaptureContext {
  private mode!: string;
  private limit?: number;
  private fmt?: string;

  constructor(mode, limit?, fmt?) {
    this.mode = mode;
    this.limit = limit;
    this.fmt = fmt;
  }

  static build(mode?: string, limit?: number, fmt?: string): CaptureContext {
    if (!mode || mode === "all") {
      mode = CaptureMode.HEAD;
      limit = undefined;
    }

    fmt = fmt ? fmt.toLowerCase() : "str";

    const get_key = (e: object, s: string) => Object.keys(e).find((k) => e[k] == s);

    if (!get_key(CaptureMode, mode)) {
      throw new Error(`Invalid output capture mode: ${mode}`);
    }
    if (!get_key(CaptureFormat, fmt)) {
      throw new Error(`Invalid output capture format: ${fmt}`);
    }

    return new CaptureContext(mode, limit, fmt);
  }

  to_dict() {
    const inner = {};

    if (this.limit) {
      inner[this.mode] = this.limit;
    }

    if (this.fmt) {
      inner["format"] = this.fmt;
    }

    return { [this.mode === CaptureMode.STREAM ? "stream" : "atEnd"]: inner };
  }

  is_streaming() {
    return this.mode === CaptureMode.STREAM;
  }
}
