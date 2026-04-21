declare namespace Bun {
  interface ServeOptions {
    port?: number;
    hostname?: string;
    fetch(req: Request): Response | Promise<Response>;
  }
  interface Server {
    port: number;
  }
  function serve(options: ServeOptions): Server;
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

declare var process: {
  env: NodeJS.ProcessEnv;
  exit(code?: number): never;
};

declare module "fs" {
  export function appendFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}
