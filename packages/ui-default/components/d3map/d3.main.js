import * as d3 from "d3";
import initD3 from "./d3.map";

export default function D3Main() {
  const width = 200;
  const height = 200;

  const svg = d3.select("#d3-main")
    .attr("viewBox", [-width / 2, -height / 2, width, height])
    .attr("preserveAspectRatio", "xMidYMid meet")
    .attr("style", "width: 100%; height: 100%;")
    .style("background-image", "url('https://picsum.photos/400/300')")
    .style("background-size", "cover")
    .style("background-position", "center");

  const nodes = JSON.parse(JSON.stringify(UiContext.nodes));

  const mainNodes = nodes.filter(node => node.type === 'main');

  svg.selectAll("*").remove();

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
      initD3(d.id);

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

  const simulation = d3.forceSimulation(mainNodes)
    .force("center", d3.forceCenter(0, 0))
    .on("tick", ticked);
}