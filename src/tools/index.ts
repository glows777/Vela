import { tool } from "ai";
import z from "zod";

export const weatherToolParamSchema = z.object({
  city: z.string().describe("要查询天气的城市名称"),
});

export const weatherTool = tool({
  title: "get_weather",
  description: "查询指定城市的天气信息",
  inputSchema: weatherToolParamSchema,
  execute: async ({ city }: { city: string }) => {
    const mockWeather: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
    };
    return mockWeather[city] || `${city}：暂无数据`;
  },
});

export const calculatorToolParamSchema = z.object({
  expression: z.string().describe('要计算的数学表达式，如 "2 + 3 * 4"'),
});

export const calculatorTool = tool({
  title: "calculator",
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  inputSchema: calculatorToolParamSchema,
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
});
