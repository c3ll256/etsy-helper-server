import { Injectable, Logger } from '@nestjs/common';
import { AliyunService } from 'src/common/services/aliyun.service';

@Injectable()
export class VariationParsingService {
  private readonly logger = new Logger(VariationParsingService.name);

  constructor(private readonly aliyunService: AliyunService) {}

  /**
   * Parse order variations using LLM
   */
  public async parseVariations(variationsString: string, templateDescription?: string): Promise<{
    variations: { [key: string]: string };
    hasMultiple: boolean;
    personalizations: Array<Array<{ id: string; value: string }>>;
    originalVariations: string;
  }> {
    if (!variationsString) {
      return {
        variations: null,
        hasMultiple: false,
        personalizations: [],
        originalVariations: ''
      };
    }
    
    // 仅本地测试用：没有 LLM key 时用简单规则模拟解析结果，生产环境不要开启
    if (process.env.VARIATION_PARSER_MOCK === 'true') {
      return this.mockParse(variationsString, templateDescription);
    }

    try {
      const prompt = this.buildParsingPrompt();
      const userPrompt = this.buildUserPrompt(variationsString, templateDescription);

      try {
        const parsedResult = await this.aliyunService.generateJson(userPrompt, { systemPrompt: prompt });
        this.logger.log(`Parsed result: ${JSON.stringify(parsedResult)}`);
        return {
          ...parsedResult,
          originalVariations: variationsString
        };
      } catch (jsonError) {
        this.logger.warn(`Failed to parse variations using GLM JSON: ${jsonError.message}`);
        throw new Error(`Failed to parse variations: ${jsonError.message}`);
      }
    } catch (error) {
      this.logger.error(`Error parsing variations using LLM: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * 本地测试用的规则解析：Personalization 之后的内容按行依次填入模板字段，多出的行并入最后一个字段
   */
  private mockParse(variationsString: string, templateDescription?: string) {
    const text = variationsString.replace(/\r\n?/g, '\n');
    const variations: { [key: string]: string } = {};
    let personalization = '';
    const marker = text.search(/Personali[sz]ation\s*:?/i);
    const head = marker >= 0 ? text.slice(0, marker) : text;
    if (marker >= 0) {
      personalization = text.slice(marker).replace(/^Personali[sz]ation\s*:?/i, '').trim();
    }
    for (const part of head.split(/[,\n]/)) {
      const idx = part.indexOf(':');
      if (idx > 0) variations[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }

    let fieldIds: string[] = [];
    try {
      const json = (templateDescription || '').split('\n').find(line => line.trim().startsWith('['));
      fieldIds = (JSON.parse(json || '[]') as Array<{ id: string }>).map(f => f.id).filter(Boolean);
    } catch {
      fieldIds = [];
    }
    const iconCodes = (personalization.match(/\b[A-Za-z]{1,2}\s*-?\s*\d{1,2}\b/g) || []).join(', ');
    fieldIds = fieldIds.filter(id => id !== '__icon_code');
    const lines = personalization.split('\n').map(line => line.trim()).filter(Boolean);
    const group: Array<{ id: string; value: string }> = [];
    if ((templateDescription || '').includes('__icon_code')) {
      group.push({ id: '__icon_code', value: iconCodes });
    }
    fieldIds.forEach((id, index) => {
      if (index < fieldIds.length - 1) {
        group.push({ id, value: lines[index] ?? '' });
      } else {
        group.push({ id, value: lines.slice(index).join(' ') });
      }
    });

    return {
      variations,
      hasMultiple: false,
      personalizations: group.length ? [group] : [],
      originalVariations: variationsString,
    };
  }

  /**
   * Build prompt for parsing variations
   */
  private buildParsingPrompt(): string {
    return `
你是一位解析订单的专家。你需要完成两个任务：
1. 将原始的变量字符串解析为JSON格式
2. 分析是否包含多个个性化信息，并将每个个性化信息根据模板描述 (description) 解析为结构化数据

请按照以下格式返回JSON:
{
  "variations": {
    "字段名1": "值1",
    "字段名2": "值2",
    ...
  },
  "hasMultiple": true/false, // 是否包含多个 Personalization 信息
  "personalizations": [    // 每个 Personalization 的结构化数据
    [
      {
        "id": "id_1",
        "value": "值1"
      },
      {
        "id": "id_2",
        "value": "值2"
      },
      ...
    ],
    ... // 可能还有更多个性化信息
  ]
}

特别注意:
1. 个性化信息 (personalizations) 是最重要的字段，必须确保100%完整保留，尤其是地址、名称等信息
2. 如果只有一个个性化信息，hasMultiple 应为 false
3. 保持原始文本的精确性，不要添加或删除内容
4. 一定要保证填写每一个字段，根据模版字段的描述 (description) 来匹配信息应该填写到哪个字段
5. 注意，有的时候会有多个名称一类的在一行，可能会以逗号或者空格隔开，这种情况下不要拆分为多个个性化信息
6. 仅输出JSON对象，不要有任何其他文本

注意！！！每个结构化数据的 key-value 的 key 是模版描述中的 id (不要自己编造，严格按照模版描述中的 id)！！！

例如，对于如下原始变量:
"Stamp Type:Wood Stamp + ink pad,Design Options:#4,Personalization:The Bradys
50 South Circle V Drive
Manila, UT 84046"

以及如下模版:
[
  {"id":"name","description":"名字或团体名称","defaultValue":"default"},
  {"id":"address_line1","description":"地址栏一","defaultValue":"address1"},
  {"id":"address_line2","description":"地址栏二","defaultValue":"address2"},
  ... // 可能还有更多字段
]

正确的解析应为如下:
{
  "variations": {
    "Stamp Type": "Wood Stamp + ink pad",
    "Design Options": "#4"
  },
  "hasMultiple": false,
  "personalizations": [
    [
      {
        "id": "name",
        "value": "The Bradys"
      },
      {
        "id": "address_line1",
        "value": "50 South Circle V Drive"
      },
      {
        "id": "address_line2",
        "value": "Manila, UT 84046"
      }
    ]
  ]
}
`;
  }

  /**
   * Build user prompt for parsing variations
   */
  private buildUserPrompt(variationsString: string, templateDescription?: string): string {
    return `${templateDescription ? `
模版如下，请根据模版字段的描述 (description) 来理解和提取相关字段：
${templateDescription}
` : ''}

原始变量字符串:
${variationsString}`;
  }
}

