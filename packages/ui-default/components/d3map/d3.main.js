import * as d3 from "d3";

export default function D3Main() {
  const width = 200;
  const height = 200;

  const svg = d3.select("#d3-main")
    .attr("viewBox", [-width / 2, -height / 2, width, height])
    .attr("preserveAspectRatio", "xMidYMid meet")
    .attr("style", "width: 100%; height: 100%;");

  // 深拷贝数据以避免共享引用
  const nodes = JSON.parse(JSON.stringify(UiContext.nodes));

  // 过滤出所有 main 节点
  const mainNodes = nodes.filter(node => node.type === 'main');

  // 清除之前的内容
  svg.selectAll("*").remove();

  // 渲染 main 节点
  const node = svg.append("g")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .selectAll("circle")
    .data(mainNodes)
    .enter()
    .append("circle")
    .attr("r", 6)
    .attr("fill", "steelblue")
    .on("mouseover", (event, d) => {
      d3.select("#info-display").text(
        `Node ${d.id}: \nContent: ${d.content}`
      );
    })
    .on("mouseout", () => {
      d3.select("#info-display").text("");
    })
    .on("click", (event, d) => {
      const targetElement = document.getElementById(`comment-${d.id}`);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth" });
      }
    })
    .call(d3.drag()
      .on("start", (event, d) => {
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        d.fx = null;
        d.fy = null;
      })
    );

  function ticked() {
    node
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);
  }

  // 创建一个独立的力模拟
  const simulation = d3.forceSimulation(mainNodes)
    .force("center", d3.forceCenter(0, 0))
    .on("tick", ticked);
}