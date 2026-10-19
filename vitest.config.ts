import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // bench/tasks contains projects that fail on purpose; they are graded by bench/run.sh.
    exclude: [...configDefaults.exclude, "bench/**", "smoke-project/**"],
  },
});
