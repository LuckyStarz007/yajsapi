import { chomp, streamWrite, streamEnd, chunksToLinesAsync } from "@rauschma/stringio";
import { spawn, ChildProcess } from "child_process";
import { StorageProvider, Destination, Source, Content } from ".";
import { AsyncExitStack, logger } from "../utils";

import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import tmp from "tmp";

class PubLink {
  //"""GFTP linking information."""

  public file!: string;
  //"""file on local filesystem."""

  public url!: string;
  //"""GFTP url as which local files is exposed."""
}

let CommandStatus: string;

class GftpDriver {
  private _proc;
  private _reader;
  //Protocol
  //"""Golem FTP service API.

  async version(): Promise<any> {
    //"""Gets driver version."""
    return await this._jsonrpc("version");
  }

  async publish(files: string[]): Promise<any> {
    /*Exposes local file as GFTP url.
    `files`
    :   local files to be exposed
    */
    return await this._jsonrpc("publish", { files });
  }

  // async close(urls: string[]): Promise<CommandStatus> {
  //     //"""Stops exposing GFTP urls created by [publish(files=[..])](#publish)."""
  //     pass
  // }

  async receive(output_file: string): Promise<any> {
    /*Creates GFTP url for receiving file.
    :  `output_file` -
    */
    return await this._jsonrpc("receive", { output_file });
  }

  async close(urls: string[]): Promise<any> {
    /*
     * Stops exposing GFTP urls created by publish(files)
     */
    return await this._jsonrpc("close", { urls });
  }

  // async upload(file: string, url: string) {
  //     pass
  // }

  async shutdown(): Promise<any> {
    /*Stops GFTP service.
      After shutdown all generated urls will be unavailable.
    */
    // await this._jsonrpc("shutdown");
    await streamEnd(this._proc.stdin);
  }

  async _jsonrpc(method: string, params: object = {}) {
    if (!this._reader) {
      this._reader = this._readStream(this._proc.stdout);
    }
    const paramsStr = JSON.stringify(params);
    const query = `{"jsonrpc": "2.0", "id": "1", "method": "${method}", "params": ${paramsStr}}\n`;
    let valueStr = "";
    await streamWrite(this._proc.stdin, query);
    try {
      const { value } = await this._reader.next();
      valueStr = JSON.stringify(value);
      const { result } = JSON.parse(value as string);
      if (result === undefined) {
        throw value;
      }
      return result;
    } catch (error) {
      const msg = `gftp error. query: ${query} value: ${valueStr} error: ${JSON.stringify(error)}`;
      logger.error(msg);
      throw Error(error);
    }
  }

  async *_readStream(readable) {
    for await (const line of chunksToLinesAsync(readable)) {
      yield chomp(line);
    }
  }
}

function service(debug = false) {
  return new _Process(debug);
}

class _Process {
  _debug;
  _proc?;

  constructor(_debug = false) {
    this._debug = _debug;
    this._proc = null;
  }

  async ready(): Promise<GftpDriver> {
    const env: NodeJS.ProcessEnv = this._debug ? { ...process.env, RUST_LOG: "debug" } : { ...process.env };
    this._proc = await spawn("gftp server", [], {
      shell: true,
      env: env,
    });
    const gftp = new GftpDriver();
    gftp["_proc"] = this._proc;
    return gftp;
  }

  async done() {
    // with contextlib.suppress(Exception):
    await this._close();
  }

  async _close() {
    if (!this._proc) return;
    const p: ChildProcess = this._proc;
    this._proc = null;

    // with contextlib.suppress(Exception):
    // await GftpDriver.shutdown();

    if (p.stdin) {
      p.stdin.destroy(); // p.stdin.close()
      // try {
      //   await Promise.any([waitProcess(p), sleep(10)]);
      //   return;
      // } catch (err) {}
    }
    p.kill();
    const ret_code = await p.signalCode;
    logger.debug(`GFTP server closed, code=${ret_code}`);
  }

  _log_debug(msg_dir: string, msg: string | Buffer) {
    if (this._debug) {
      if (msg instanceof Buffer) msg = msg.toString("utf-8");
      const stderr = process.stderr;
      stderr.write(msg_dir == "in" ? "\n <= " : "\n => ");
      stderr.write(msg);
    }
  }

  async send_message(message) {
    if (!this._proc) return;
    if (!this._proc.stdin) return;
    if (!this._proc.stdout) return;
    const _message = message.serialize() + "\n";
    const buffer = Buffer.from(_message, "utf-8");
    this._log_debug("out", _message);
    this._proc.stdin.write(buffer);
    await this._proc.stdin.drain();
    let msg = await this._proc.stdout.readline();
    this._log_debug("in", msg);
    try {
      msg = JSON.parse(msg);
    } catch (error) {
      logger.error(`gftp error ${error} while parsing ${msg}`);
      throw error;
    }
    return message.parse_response(msg);
  }
}

function _temp_file(temp_dir: string): string {
  const file_name = path.join(temp_dir, uuid().toString());
  if (fs.existsSync(file_name)) fs.unlinkSync(file_name);
  return file_name;
}

class GftpSource extends Source {
  private _len;
  private _link;
  constructor(length: number, link: PubLink) {
    super();
    this._len = length;
    this._link = link;
  }

  download_url(): string {
    return this._link["url"];
  }

  async content_length(): Promise<number> {
    return this._len;
  }
}

class GftpDestination extends Destination {
  private _proc;
  private _link;
  constructor(_proc: GftpDriver, _link: PubLink) {
    super();
    this._proc = _proc;
    this._link = _link;
  }

  upload_url(): string {
    return this._link["url"];
  }

  async download_stream(): Promise<Content> {
    const file_path = this._link["file"];
    const length = fs.statSync(file_path)["size"];

    async function* chunks(): AsyncGenerator<Buffer> {
      const stream = fs.createReadStream(file_path, {
        highWaterMark: 30000,
        encoding: "binary",
      });
      stream.once("end", () => {
        stream.destroy();
      });
      for await (const chunk of stream) yield chunk;
    }

    return new Content(length, chunks());
  }

  async download_file(destination_file: string) {
    if (destination_file.toString() == this._link["file"]) return;
    return await super.download_file(destination_file);
  }
}

class GftpProvider extends StorageProvider {
  _temp_dir?: string | null;
  __exit_stack;
  _process;

  constructor(tmpdir: string | null = null) {
    super();
    this.__exit_stack = new AsyncExitStack();
    this._temp_dir = tmpdir || null;
    this._process = null;
  }

  async ready(): Promise<StorageProvider> {
    this._temp_dir = tmp.dirSync().name;
    const _process = await this.__get_process();
    const _ver = await _process.version();
    logger.info(`GFTP Version:${_ver}`);
    if (!_ver) throw Error("GFTP couldn't found.");
    return this as StorageProvider;
  }

  async done(): Promise<boolean | null | void> {
    await this.__exit_stack.aclose();
    return null;
  }

  __new_file(): string {
    const temp_dir: string = this._temp_dir || tmp.dirSync().name;
    if (!this._temp_dir) this._temp_dir = temp_dir;
    const temp_file = _temp_file(temp_dir);
    return temp_file;
  }

  async __get_process(): Promise<GftpDriver> {
    const _debug = !!process.env["DEBUG_GFTP"];
    const _process = this._process || (await this.__exit_stack.enter_async_context(service(_debug)));
    if (!this._process) this._process = _process;
    return _process;
  }

  async upload_stream(length: number, stream: AsyncGenerator<Buffer>): Promise<Source> {
    const file_name = this.__new_file();
    const wStream = fs.createWriteStream(file_name, {
      encoding: "binary",
    });
    // eslint-disable-next-line no-async-promise-executor
    await new Promise(async (fulfill) => {
      wStream.once("finish", fulfill);
      for await (const chunk of stream) {
        wStream.write(chunk);
      }
      wStream.end();
    });
    const _process = await this.__get_process();
    const links = await _process.publish([file_name.toString()]);
    if (links.length !== 1) throw "invalid gftp publish response";
    const link = links[0];
    return new GftpSource(length, link);
  }

  async upload_file(_path: string): Promise<Source> {
    const _process = await this.__get_process();
    const links = await _process.publish([_path.toString()]);
    const length = fs.statSync(_path)["size"];
    if (links.length !== 1) throw "invalid gftp publish response";
    return new GftpSource(length, links[0]);
  }

  async new_destination(destination_file: string | null = null): Promise<Destination> {
    // Temporary disable for checking new transfer approach (without after hook)
    // if (destination_file) {
    //   if (fs.existsSync(destination_file)) {
    //     destination_file = null;
    //   }
    // }
    const output_file = destination_file ? destination_file.toString() : this.__new_file();
    const _process = await this.__get_process();
    const link = await _process.receive(output_file);
    return new GftpDestination(_process, link);
  }

  async release(urls: string[]): Promise<void> {
    const _process = await this.__get_process();
    await _process.close(urls);
  }
}

export function provider(): any {
  return new GftpProvider();
}
