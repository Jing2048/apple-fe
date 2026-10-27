import { STAR_GROUPS } from './logic';

export type PostThemeId = 'classic' | 'new-year';

export interface PostBlessing {
  readonly name: string;
  readonly title: string;
  readonly lines: readonly [string, string];
}

interface StationCopy {
  readonly label: string;
  readonly hint: string;
}

export interface PostTheme {
  readonly id: PostThemeId;
  readonly brand: string;
  readonly brandEnglish: string;
  readonly heroKicker: string;
  readonly heroTitle: readonly [string, string];
  readonly heroIntro: readonly [string, string];
  readonly heroCaption: string;
  readonly envelopeTo: string;
  readonly stations: readonly [StationCopy, StationCopy, StationCopy];
  readonly completionKicker: string;
  readonly completionTitle: readonly [string, string];
  readonly completionIntro: string;
  readonly cardLabel: string;
  readonly cardEnglish: string;
  readonly cardTo: string;
  readonly cardClosing: string;
  readonly postmark: string;
  readonly footer: string;
  readonly blessings: readonly [PostBlessing, PostBlessing, PostBlessing];
}

export const POST_THEMES: Readonly<Record<PostThemeId, PostTheme>> = {
  classic: {
    id: 'classic',
    brand: '云朵邮局',
    brandEnglish: 'CLOUD POST OFFICE',
    heroKicker: '一封不用着急抵达的信',
    heroTitle: ['把一点点星光，', '寄给今天的自己'],
    heroIntro: ['陪小云朵走一小段路，收集六颗星光。', '把心里的晴天，装进一封小小的祝福里。'],
    heroCaption: '你的云朵邮差，已经准备好啦',
    envelopeTo: 'TO: 今天的你',
    stations: STAR_GROUPS,
    completionKicker: '六颗星光，刚刚好',
    completionTitle: ['你的星光，', '已经装进信里'],
    completionIntro: '选一句祝福，送给认真生活的自己。',
    cardLabel: '一封晴天来信',
    cardEnglish: 'A LITTLE LETTER OF LIGHT',
    cardTo: 'TO: 今天的你',
    cardClosing: '愿所有小小的光，都有回响。',
    postmark: '星光邮局',
    footer: '云朵邮局 · 把晴天寄给你',
    blessings: [
      {
        title: '愿你慢慢来，也会闪闪发光。',
        lines: ['不必追上每一阵风，', '你的步调，也有自己的晴天。'],
        name: '寄给慢慢来的你',
      },
      {
        title: '愿小小的好运，恰好落在你身边。',
        lines: ['把今天的温柔收进口袋，', '下一站，会遇见新的好事。'],
        name: '寄给值得好运的你',
      },
      {
        title: '愿你被生活温柔以待。',
        lines: ['忙碌的日子也别忘了，', '留一点点星光，照亮自己。'],
        name: '寄给认真生活的你',
      },
    ],
  },
  'new-year': {
    id: 'new-year',
    brand: '新春云朵邮局',
    brandEnglish: 'NEW YEAR CLOUD POST',
    heroKicker: '新意在心里，心意在路上',
    heroTitle: ['把新意，', '带回家'],
    heroIntro: ['陪云朵收集六颗金色心愿星，', '把迎新、团圆与心愿，装进一封祝福邮笺。'],
    heroCaption: '云朵邮差，把新春心意带回家',
    envelopeTo: 'TO: 惦记的人',
    stations: [
      { label: '迎新', hint: '捎上一点新意，把好事迎进门' },
      { label: '团圆', hint: '把暖暖的惦念，寄给心里的人' },
      { label: '心愿', hint: '收好小小的愿望，迎接新的好光景' },
    ],
    completionKicker: '六颗心愿星，一封新春信',
    completionTitle: ['把新春心意，', '装进一封家书'],
    completionIntro: '选一句新春祝福，把心意带回家。',
    cardLabel: '祝福邮笺',
    cardEnglish: 'A LITTLE WISH FOR YOU',
    cardTo: 'TO: 新一年的你',
    cardClosing: '愿每一份心意，都有温暖的归处。',
    postmark: '新春邮局',
    footer: '新春云朵邮局 · 把新意，带回家',
    blessings: [
      {
        title: '愿新的一年，常有新意，也常有欢喜。',
        lines: ['把一小束好事带在身边，', '新的日子，也会慢慢发光。'],
        name: '寄给新一年的你',
      },
      {
        title: '愿想念都有回音，团圆就在身边。',
        lines: ['把惦念轻轻放进信里，', '愿每一程奔赴，都有人等候。'],
        name: '寄给想团圆的你',
      },
      {
        title: '愿心里的小愿望，慢慢长成好光景。',
        lines: ['让希望在掌心轻轻发芽，', '把新的好光景，慢慢过成日常。'],
        name: '寄给许心愿的你',
      },
    ],
  },
};
