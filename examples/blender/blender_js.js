const path = require("path");
const dayjs = require("dayjs");
const duration = require("dayjs/plugin/duration");
const { Executor, Task, utils, vm } = require("yajsapi");
const { program } = require("commander");

dayjs.extend(duration);

const { logUtils, range } = utils;

async function main(subnetTag, driver, network) {
  const _package = await vm.repo({
    image_hash: "9a3b5d67b0b27746283cb5f287c13eab1beaa12d92a9f536b747c7ae",
    min_mem_gib: 0.5,
    min_storage_gib: 2.0,
  });

  async function* worker(ctx, tasks) {
    ctx.send_file(path.join(__dirname, "./cubes.blend"), "/golem/resource/scene.blend");

    for await (let task of tasks) {
      let frame = task.data();
      let crops = [
        {
          outfilebasename: "out",
          borders_x: [0.0, 1.0],
          borders_y: [0.0, 1.0],
        },
      ];
      ctx.send_json("/golem/work/params.json", {
        scene_file: "/golem/resource/scene.blend",
        resolution: [400, 300],
        use_compositing: false,
        crops: crops,
        samples: 100,
        frames: [frame],
        output_format: "PNG",
        RESOURCES_DIR: "/golem/resources",
        WORK_DIR: "/golem/work",
        OUTPUT_DIR: "/golem/output",
      });
      ctx.run("/golem/entrypoints/run-blender.sh");
      const output_file = `output_${frame.toString()}.png`;
      ctx.download_file(
        `/golem/output/out${frame.toString().padStart(4, "0")}.png`,
        path.join(__dirname, `./output_${frame}.png`)
      );
      yield ctx.commit({ timeout: dayjs.duration({ seconds: 120 }).asMilliseconds() });
      // TODO: Check
      // job results are valid // and reject by:
      // task.reject_task(msg = 'invalid file')
      task.accept_result(output_file);
    }

    ctx.log("no more frames to render");
  }

  const frames = range(0, 60, 10);
  const timeout = dayjs.duration({ minutes: 15 }).asMilliseconds();

  const executor = new Executor({
    task_package: _package,
    max_workers: 6,
    timeout: timeout,
    budget: "10.0",
    subnet_tag: subnetTag,
    driver: driver,
    network: network,
    event_consumer: logUtils.logSummary(),
  });
  await executor.run(async (executor) => {
    for await (let task of executor.submit(
      worker,
      frames.map((frame) => new Task(frame))
    )) {
      console.log("result=", task.result());
    }
  });
}

program
  .option("--subnet-tag <subnet>", "set subnet name, for example 'devnet-beta'")
  .option("--payment-driver, --driver <driver>", "payment driver name, for example 'erc20'")
  .option("--payment-network, --network <network>", "network name, for example 'rinkeby'")
  .option("-d, --debug", "output extra debugging");
program.parse();
const options = program.opts();
if (options.debug) {
  utils.changeLogLevel("debug");
}
main(options.subnetTag, options.driver, options.network);
