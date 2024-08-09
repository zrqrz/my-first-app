import { Probot } from "probot";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Redis } from "ioredis";

interface File {
  path?: string | undefined;
  mode?: string | undefined;
  type?: string | undefined;
  sha?: string | undefined;
  size?: number | undefined;
  url?: string | undefined;
}

const redis = new Redis("rediss://default:Aa0tAAIncDFlYzMzZGY5NzhiOWM0ZWI1OWExN2NiNTA0ZWYyYzkxMnAxNDQzMzM@right-rattler-44333.upstash.io:6379");

export default (app: Probot, { getRouter }: any) => {
  app.log.info("Coexplain Github App is loaded.");

  app.on("issues.labeled", async (context) => {
    if (context.payload.action === "labeled" && context.payload.label) {
      if (context.payload.label.name === "Estimate with Coexplain") {
        context.log.info("Process label event: ", JSON.stringify(context.payload.issue.title))
        const issueBody = context.payload.issue.body;

        const repoFullname = context.payload.repository.full_name;

        const rateLimit = await redis.get(`rate-limit-${repoFullname}`);
        let rateLimitNum = 0;
        if (rateLimit) {
          rateLimitNum = parseInt(rateLimit);
          if (rateLimitNum > 5 && context.payload.repository.owner.name !== 'coexplain') {
            context.log.warn(`${repoFullname} has reached to rate limit.`)
            return;
          }
          await redis.set(`rate-limit-${repoFullname}`, rateLimitNum + 1);
        } else {
          await redis.set(`rate-limit-${repoFullname}`, 1, "EX", "86400");
        }

        const reponse = await context.octokit.rest.git.getTree({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          recursive: "true",
          tree_sha: context.payload.repository.default_branch,
        });

        const { tree: files } = reponse.data;

        context.log.info(`Fetched ${files.length} repo files`);

        const mainLanguage = context.payload.repository.language?.toLowerCase();

        let filteredFiles = files;
        if (mainLanguage) {
          const extensions = getExtensionByLanguage(mainLanguage);
          const targetFileExtensions = new Set(extensions);

          filteredFiles = files.filter((file) => {
            if (!file.path || (file.type && file.type === "tree")) {
              return false;
            }

            const ext = getFileExtension(file.path);

            if (ext === undefined) {
              return false;
            }
            if (targetFileExtensions.has(ext)) {
              return true;
            }
            return false;
          });
        }

        context.log.info(`Filtered fetched repo files to ${filteredFiles.length}`);

        const fileMap = new Map<string, File>();
        for (let file of filteredFiles) {
          fileMap.set(file.path!, file);
        }

        const genAI = new GoogleGenerativeAI(
          "AIzaSyBDBcAqufWpzZg2bI1HJRTqJrTXdryDbx0"
        );

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const filePathAndSize = filteredFiles
          .map((file) => `${file.path}, ${file.size}`)
          .join("\n");
        const timeEstimationPrompt = `As an experienced software engineer, estimate the development time required to resolve the following issue in the ${repoFullname} GitHub repository. The output should provide an estimated time in hours, including a breakdown of time spent on understanding & reproducing the issue, implementation, testing & debugging. Use plain text format only and include no additional response.\n\n${issueBody}\n\nHere are all the code files and their sizes for additional context in the estimation:\n\n${filePathAndSize}`;

        const timeEstimationResult = await model.generateContent([
          timeEstimationPrompt,
        ]);

        context.log.info(`Time estimation generated, total length: ${timeEstimationResult.response.text().length}`);

        let comment = `## Estimated Time\n${timeEstimationResult.response.text()}\n`;

        const filePathsForPrompt = filteredFiles
          .map((file) => file.path)
          .join("\n");
        const impatctedFilesPrompt = `Given the following issue in the ${repoFullname} GitHub repository:\n\n${issueBody}\n\nSelect the code file paths related to solving this GitHub issue from the following repository file paths. Exclude any test, type, design, or documentation file paths, and include only core implementation logic files. Show only the relevant code files and as few as possible. Provide the response in the same format as the given file paths without any markdown formatting.\n\n${filePathsForPrompt}`;

        const impatctedFilesResult = await model.generateContent([
          impatctedFilesPrompt,
        ]);

        const stringPaths = impatctedFilesResult.response
          .text()
          .split(/\r?\n/)
          .filter((path) => fileMap.has(path));
        const hyperLinkPaths = stringPaths
          .map(
            (path) =>
              `[${path}](${context.payload.repository.html_url}/tree/${context.payload.repository.default_branch}/${path})`
          )
          .join("\n");

        context.log.info(`Related files generated, total length of files: ${hyperLinkPaths.length}`);

        comment += `## Related Files\n${hyperLinkPaths}`;

        const issueComment = context.issue({
          body: comment,
        });
        await context.octokit.issues.createComment(issueComment);
      }
    }
  });
  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};

function getFileExtension(filePath: string) {
  // Extract the file name from the path
  const fileName = filePath.split("/").pop();

  if (!fileName) {
    return undefined;
  }

  // Extract the file extension from the file name
  const extension = fileName.includes(".")
    ? fileName.split(".").pop()
    : undefined;

  return extension;
}

const languageToExtension: { [key: string]: string[] } = {
  python: [".py"],
  r: [".r", ".R"],
  javascript: [".js", ".mjs", ".jsx"],
  typescript: ["tsx", ".ts"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  ruby: [".rb"],
  php: [".php"],
  ocaml: [".ml"],
  scala: [".scala"],
  objc: [".m"],
  perl: [".pl"],
  shell: [".sh", ".bash"],
  "c++": [".cpp", ".cc"],
  c: [".c"],
  html: [".html"],
  css: [".css"],
  kotlin: [".kt"],
  yaml: [".yaml"],
  sql: [".sql"],
  json: [".json"],
  hack: [".hack"],
  haskell: [".hs"],
  erlang: [".erl"],
  cmake: [".cmake"]
};

function getExtensionByLanguage(language: string) {
  const lower = language.toLowerCase();
  if (lower in languageToExtension) {
    return languageToExtension[lower];
  }
  return [];
}
