# js-bach MVP 规划

首版选用《平均律键盘曲集》第一卷的 BWV 846 前奏曲和赋格。用户可以在浏览器选乐章、播放、停止，并单独试听赋格的四个声部。用前奏曲展示节奏模板如何复用，用赋格验证多声部导入和播放。

## 版本与署名

两份输入都是 Noctave 发布的 MusicXML 4.0 `.mxl`。保留原文件及其权利声明，在源码仓库、发布包和演示页注明曲名、BWV 编号、作曲者、Mutopia 排谱者、Noctave 数字化版本、来源链接和权利状态。编译产物通过乐章标识指向同一份来源记录。项目代码沿用仓库的 GPLv3，乐谱沿用各自的上游权利声明。 [GPLv3](../LICENSE) · [Creative Commons 署名指南](https://wiki.creativecommons.org/Recommended_practices_for_attribution)

| 乐章 | 所选数字版与上游 | `.mxl` 的 SHA-256 |
| --- | --- | --- |
| BWV 846 前奏曲 | Noctave，CC0 1.0，基于 Tobias Erbsland 的公有领域 Mutopia 版。 [Noctave 谱源](https://noctavepiano.com/partitions/bach-prelude-bwv846/) · [Mutopia 记录](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=5) | `1bfe6a105c2285cf22eb13a0d0c3bd46cd8a6c39a7158ce0545d5e5662b55049` |
| BWV 846 赋格 | Noctave，数字谱声明为公有领域，基于 Andreas Scherer 的公有领域 Mutopia 版。 [Noctave 谱源](https://noctavepiano.com/en/free-library/bach-das-wohltemperierte-clavier-i-fuga-bwv-846/) · [Mutopia 记录](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=4) | `db81946326133de5aaf0a1b474173595829be6499b629144cbdc233efcd4b984` |

两份 MusicXML 都与各自对应的 Mutopia MIDI 逐一对过不同的 `(起音位置, MIDI 音高)` 组合。以四分音符为时间单位，去掉延音续段并合并重合的同音起点后，前奏曲的 549 组及赋格的 727 组完全匹配。Mutopia 两条记录都未注明更早的底本。这个同源跨格式检查覆盖音高和起音，时值、声部与记谱细节在导入验收时另行核对。 [前奏曲上游文件](https://www.mutopiaproject.org/ftp/BachJS/BWV846/wtk1-prelude1/) · [赋格上游文件](https://www.mutopiaproject.org/ftp/BachJS/BWV846/wtk1-fugue1/)

扩充曲库时按文件使用上游许可。Mutopia 同时提供公有领域、CC BY 和 CC BY-SA 等版本，具体以曲目页为准。CC BY 的署名要附许可链接和修改说明，CC BY-SA 的改编版还要遵守相同方式共享条款。Humdrum 的《平均律》和 Tobis 的大型作品先作为参考，随项目分发前核实具体文件的权利。DCMLab 圣咏库标示 CC0，但作者已记录格式转换引入的升降记号错误，入库前需按曲校对。 [Mutopia 目录](https://www.mutopiaproject.org/cgibin/make-table.cgi?Composer=BachJS) · [CC BY](https://creativecommons.org/licenses/by/4.0/) · [CC BY-SA](https://creativecommons.org/licenses/by-sa/4.0/) · [Humdrum](https://github.com/humdrum-tools/bach-wtc) · [Tobis](https://tobis-notenarchiv.de/wp/en/bach-archive/) · [DCMLab](https://dcmlab.github.io/bach_chorales/)

## 实施顺序与验收

1. **导入两个乐章。** 在单个 TypeScript 项目中用 Node.js 读取固定的 `.mxl`，输出按乐章记录的 Score IR。保留小节、精确拍内位置、时值、书写音高、谱表、声部、延音和装饰音标记。正确处理休止、和弦与 `backup` 对时间游标的影响。编译错误带小节位置，便于定位不支持的演奏语义。验收包括两份输入的哈希、35 和 27 小节、549 和 727 组起音基准，以及对照上游谱人工确认的跨小节延音、同拍多音和赋格声部片段。 [MusicXML 4.0 规范](https://www.w3.org/2021/06/musicxml40/listings/musicxml.xsd/)
2. **播出演奏事件。** 把延音链合成一次发声，从 Score IR 生成按时间排序的演奏事件。赋格第 18 和 19 小节的装饰音在谱数据中保留，试听按上游参考 MIDI 播放所标注的主音。浏览器通过点击启动音频上下文，用 Web Audio 的音频时钟预排振荡器。验收包括两个乐章均可完整播放、停止后可重新开始、赋格四个声部均能单独试听。 [Web Audio 规范](https://www.w3.org/TR/webaudio-1.0/)
3. **实现一条可验证的结构改写。** 对前奏曲复用重复出现的起音及节奏模板，每次仍保存实际音高。普通事件和模板引用都可展开成同一份 Score IR。首版可用易检查的 JSON。验收要求两乐章展开后逐字段相同，演示页能定位前奏曲中至少一处模板复用，同时记录相同字段的普通事件流与结构编码在 Brotli 后的体积。

导入里程碑已完成。原始 `.mxl`、参考 MIDI 和来源记录位于 `corpus/bwv846/`，两乐章的起音基准可在本地离线复验。 [来源清单](../corpus/bwv846/sources.json) · [运行命令](../README.md#import-the-corpus)

播放器里程碑已完成。浏览器 demo 从导入后的 Score IR 播放两乐章，赋格的独奏试听从所选声部第一次进入开始。 [运行命令](../README.md#play-bwv-846869) · [演奏事件测试](../test/performance.test.ts)

节奏模板里程碑已完成。前奏曲第 1–32 小节复用同一个模板，第 33–34 小节复用另一个模板，第 35 小节保留原事件。赋格的整小节节奏编码保留原事件。构建前校验两乐章的展开结果，demo 标出复用位置并显示两种编码的 Brotli 大小。 [复验命令](../README.md#compare-rhythm-encoding)

赋格已增加跨小节的移调片段编码。从同声部滑窗中找出精确匹配，并用实际 Brotli 字节数筛选互不占用同一事件的组合。构建校验还原后的 Score IR，demo 按片段显示声部、小节范围和移调量。 [复验命令](../README.md#compare-transposed-fragments)

BWV 847 的两个乐章已加入语料。前奏曲第 34 小节的短 C4 与另一个长 C4 重叠，MusicXML 与 LilyPond 原谱都保留了短音，参考 MIDI 只触发长音。赋格采用 CC BY-SA 4.0，生成的谱数据保留署名和许可。四个乐章用同一组 Brotli 参数独立比较两种复用，demo 可在两套作品间切换。 [BWV 847 来源清单](../corpus/bwv847/sources.json)

BWV 848 和 849 的四个乐章沿用 Noctave MusicXML 和同源 Mutopia MIDI。这两组谱的底本是 1866 年 Breitkopf & Härtel 版，排谱者为 Davide Castellone，数字文件均标为公有领域。起音校验检查 MIDI 中的同音持续区间，并核对清单记录的倚音起音和延音重触发。BWV 848 赋格第 51–52 小节的跨声部编号延音在试听中合为一次发声。两种编码每次构建都会逐字段还原全部八个乐章，构建日志给出发布目录下的 `compression.md` 路径。 [BWV 848 来源清单](../corpus/bwv848/sources.json) · [BWV 849 来源清单](../corpus/bwv849/sources.json) · [复验命令](../README.md#compare-rhythm-encoding)

BWV 850 和 851 的四个乐章沿用同源 MusicXML 与 MIDI。BWV 850 赋格沿用 Sven Reichard 排谱版的 CC BY-SA 4.0，署名和许可随生成的谱数据分发。BWV 851 赋格第 43 小节的短 D3 与正在持续的 D3 重叠，上游 MIDI 只触发一次。构建汇总表与 demo 现覆盖 BWV 846–851 的十二个乐章。 [BWV 850 来源清单](../corpus/bwv850/sources.json) · [BWV 851 来源清单](../corpus/bwv851/sources.json)

BWV 852 采用 Open Well-Tempered Clavier 的 CC0 版，保留原始 MusicXML 合卷和 PDMX 的 MIDI 合卷，按清单中的小节和 MIDI 区间分别校验两个乐章。前奏曲第 63–64 小节中 MIDI 漏播的 15 个起音用同版印刷谱核对。BWV 853 沿用公有领域的 Noctave 和 Mutopia 同源版，前奏曲为降 E 小调，赋格为升 D 小调。构建汇总表与 demo 扩到 BWV 846–853 的十六个乐章。 [BWV 852 来源清单](../corpus/bwv852/sources.json) · [BWV 853 来源清单](../corpus/bwv853/sources.json)

BWV 854 沿用 OpenWTC 的 CC0 合卷和 PDMX MIDI。起音校验核对前奏曲的装饰音，并从前奏曲末尾延长记号之后的 MIDI 乐章边界对齐赋格。BWV 855 沿用公有领域的 Noctave MusicXML 和 Mutopia MIDI，前奏曲保留第 23 小节的速度变化。构建汇总表与 demo 扩到 BWV 846–855 的二十个乐章。 [BWV 854 来源清单](../corpus/bwv854/sources.json) · [BWV 855 来源清单](../corpus/bwv855/sources.json)

BWV 856 与 857 沿用 Noctave MusicXML 和同源 Mutopia MIDI。BWV 856 两个乐章均标为公有领域，起音全部吻合，赋格的弱起保留为第 0 小节。BWV 857 两个乐章保留 Sven Reichard / Mutopia Project 的署名与 CC BY-SA 4.0 许可。校验记录了 MIDI 中从上邻音开始的装饰音实现，试听沿用谱面主音。构建汇总表与 demo 扩到 BWV 846–857 的 24 个乐章。 [BWV 856 来源清单](../corpus/bwv856/sources.json) · [BWV 857 来源清单](../corpus/bwv857/sources.json)

BWV 858 与 859 采用 OpenWTC 的 CC0 版，分别保留 PDMX 和 Artform 的原始 MusicXML 合卷，两首作品均用 PDMX 的同版 MIDI 交叉校验。BWV 858 赋格保留源谱第 31–65 小节的编号。BWV 859 的校验记录前奏曲第 19 小节的琶音错开起音，并从 MIDI 中前奏曲后的停顿结束处对齐赋格。构建汇总表与 demo 扩到 BWV 846–859 的 28 个乐章。 [BWV 858 来源清单](../corpus/bwv858/sources.json) · [BWV 859 来源清单](../corpus/bwv859/sources.json)

BWV 860 与 861 采用标为公有领域的 Noctave MusicXML 和同源 Mutopia MIDI。其中三个乐章的起音完全吻合。BWV 860 赋格第 60、85 小节的两处同音重叠保留谱面起音，校验逐一确认对应 MIDI 的持续音。构建汇总表与 demo 扩到 BWV 846–861 的 32 个乐章。 [BWV 860 来源清单](../corpus/bwv860/sources.json) · [BWV 861 来源清单](../corpus/bwv861/sources.json)

BWV 862 与 863 采用 OpenWTC 的 CC0 版，保留 Artform 原始 MusicXML 合卷，并用 PDMX 同版 MIDI 分乐章核对。BWV 862 前奏曲第 33–34 小节的降 A 延音与 Hawryluk 的 LilyPond 源谱一致。两首赋格的起音完全吻合，两首前奏曲的差异对应 MIDI 对谱面装饰音的演奏。构建汇总表与 demo 扩到 BWV 846–863 的 36 个乐章。 [BWV 862 来源清单](../corpus/bwv862/sources.json) · [BWV 863 来源清单](../corpus/bwv863/sources.json)

BWV 864 采用 Artform 的 OpenWTC CC0 合卷和 PDMX 同版 MIDI。所有谱面起音均吻合，MIDI 额外的起音来自前奏曲第 3、14 小节的逆波音和赋格第 8、26 小节的颤音。BWV 865 采用公有领域的 Noctave MusicXML 和同源 Mutopia MIDI，两个乐章的起音完全吻合。原子发布的构建汇总表和 demo 扩到 BWV 846–865 的 40 个乐章。 [BWV 864 来源清单](../corpus/bwv864/sources.json) · [BWV 865 来源清单](../corpus/bwv865/sources.json)

BWV 866 与 867 用 `audit:sources` 审核 Artform 原始 MusicXML 合卷和 PDMX 同版 MIDI。两套文件均为 OpenWTC CC0 版，所有谱面起音均吻合。BWV 866 前奏曲第 19 小节的下波音有 2 个额外 MIDI 起音，BWV 867 赋格第 49 小节的颤音有 15 个。汇总表与 demo 扩到 BWV 846–867 的 44 个乐章。 [BWV 866 来源清单](../corpus/bwv866/sources.json) · [BWV 867 来源清单](../corpus/bwv867/sources.json)

BWV 868 与 869 均采用 OpenWTC CC0 版。BWV 868 的 MusicXML 和 MIDI 来自 PDMX 同一条目。前奏曲起音完全吻合，赋格的差异对应源谱第 21 小节的颤音与第 42 小节从上方邻音开始的逆波音。BWV 869 的 Artform MusicXML 与 PDMX 同版 MIDI 的差异均来自装饰音。其前奏曲的 47 个谱面小节保留两段反复记号，起音校验与播放器按 94 个小节展开。汇总表与 demo 覆盖第一卷 BWV 846–869 的全部 48 个乐章。 [BWV 868 来源清单](../corpus/bwv868/sources.json) · [BWV 869 来源清单](../corpus/bwv869/sources.json)
