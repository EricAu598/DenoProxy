// Add Deno types reference and make this file a module
/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.220.1/http/server.ts";

// 打开 Deno KV（全局只需打开一次）
const kv = await Deno.openKv();
// 使用一个固定的 key 来存储目标 URL
const TARGET_KEY = ["targetUrl"];
const DEFAULT_URL = "https://lalalka-gemini-balance.hf.space";

// 检查并设置默认 URL
const result = await kv.get(TARGET_KEY);
if (!result.value) {
  await kv.set(TARGET_KEY, DEFAULT_URL);
}

// 添加路径规范化函数
function normalizeGooglePath(path: string): string {
  // 将 /proxy/goog/chat/completions 转换为 /proxy/v1/chat/completions
  if (path.startsWith("/proxy/goog")) {
    return "/proxy/v1" + path.slice("/proxy/goog".length);
  }
  return path;
}

// 转换请求体格式
async function transformRequestBody(req: Request): Promise<BodyInit | null> {
  if (!req.body || !req.headers.get("content-type")?.includes("application/json")) {
    return req.body;
  }

  try {
    const jsonBody = await req.json();
    // 如果是来自 Sillytraven 的请求格式，转换为 Cherry Studio 格式
    if (jsonBody.messages && !jsonBody.stream) {
      return JSON.stringify({
        model: jsonBody.model || "gemini-1.5-pro-002",
        messages: jsonBody.messages,
        max_tokens: jsonBody.max_tokens || 100,
        stream: false
      });
    }
    return JSON.stringify(jsonBody);
  } catch (err) {
    console.error("解析请求体失败:", err);
    return req.body;
  }
}

// 设置服务器监听在 8001 端口
await serve(async (req) => {
  const url = new URL(req.url);
  
  // Add debug logging
  console.log("\n=== Request Details ===");
  console.log("Request URL:", req.url);
  console.log("Request Method:", req.method);
  console.log("\n=== Request Headers ===");
  for (const [key, value] of req.headers.entries()) {
    console.log(`${key}: ${value}`);
  }

  // Log request body if present
  if (req.body) {
    const clonedReq = req.clone();
    try {
      const body = await clonedReq.text();
      console.log("\n=== Request Body ===");
      console.log(body);
    } catch (e) {
      console.log("Could not read request body:", e);
    }
  }

  // 如果请求带有 setUrl 参数，则更新目标 URL
  if (url.searchParams.has("setUrl")) {
    const newTargetUrl = url.searchParams.get("setUrl")!;
    // 基本校验一下 URL 格式
    try {
      new URL(newTargetUrl);
    } catch {
      return new Response("无效的 URL，请检查格式。", { status: 400 });
    }
    await kv.set(TARGET_KEY, newTargetUrl);
    return new Response(`代理目标 URL 已更新为：${newTargetUrl}`);
  }

  // 仅处理路径以 /proxy 开头的请求
  if (url.pathname.startsWith("/proxy")) {
    const result = await kv.get(TARGET_KEY);
    if (!result.value) {
      return new Response(
        "未设置代理目标 URL，请使用 ?setUrl=你的目标URL 进行设置。",
        { status: 400 }
      );
    }
    const baseUrl = result.value as string;

    // 规范化路径
    const normalizedPath = normalizeGooglePath(url.pathname);
    // 去掉 /proxy 前缀，剩余部分作为相对路径
    const proxyPath = normalizedPath.slice("/proxy".length);
    // 创建一个新的 URLSearchParams，排除 key 参数
    const filteredParams = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== 'key') {
        filteredParams.set(key, value);
      }
    }
    
    // 构造最终的请求 URL：以存储的 baseUrl 为基准，加上剩余路径和过滤后的查询参数
    let finalUrl: string;
    try {
      const searchString = filteredParams.toString() ? `?${filteredParams.toString()}` : '';
      finalUrl = new URL(proxyPath + searchString, baseUrl).toString();
    } catch {
      return new Response("构造目标 URL 出错。", { status: 500 });
    }

    // 转换请求体
    const transformedBody = await transformRequestBody(req);

    // 构造一个新的请求，将客户端的 method、headers 和转换后的 body 传递过去
    const proxyRequest = new Request(finalUrl, {
      method: req.method,
      headers: req.headers,
      body: transformedBody,
    });

    try {
      const targetResponse = await fetch(proxyRequest);
      const body = await targetResponse.arrayBuffer();

      console.log("\n=== Response Details ===");
      console.log("Status Code:", targetResponse.status, targetResponse.statusText);
      console.log("\n=== Response Headers ===");
      for (const [key, value] of targetResponse.headers.entries()) {
        console.log(`${key}: ${value}`);
      }

      // 复制目标响应的 headers
      const responseHeaders = new Headers();
      for (const [key, value] of targetResponse.headers.entries()) {
        responseHeaders.set(key, value);
      }

      return new Response(body, {
        status: targetResponse.status,
        headers: responseHeaders,
      });
    } catch (err) {
      console.error("\n=== Error ===");
      console.error(err);
      return new Response(`请求目标 URL 时发生错误：${err}`, {
        status: 500,
      });
    }
  }

  // 其他请求返回提示信息
  const currentTarget = (await kv.get(TARGET_KEY)).value;
  return new Response(
      "欢迎使用 Deno Proxy：\n" +
      "1. 使用 /proxy 开头的路径发起代理请求。\n" +
      "2. 使用 ?setUrl=你的目标URL 设置代理目标。\n" +
      `当前代理目标：${currentTarget}`
  );
}, { port: 8001 });
