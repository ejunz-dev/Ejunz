import * as d3 from "d3";
import initD3 from "./d3.sub";

export default function D3Main() {
  const width = 200;
  const height = 200;

  const urlForHubImage = UiContext.urlForHubImage;

  const svg = d3.select("#d3-main")
    .attr("viewBox", [-width / 2, -height / 2, width, height])
    .attr("preserveAspectRatio", "xMidYMid meet")
    .attr("style", "width: 100%; height: 100%;")
    .style("background-image", `url(${urlForHubImage})`)
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
    .attr("cx", d => d.x)
    .attr("cy", d => d.y)
    .on("mouseover", (event, d) => {
      d3.select("#info-display").text(
        `Node ${d.id}: \nContent: ${d.content} \nX: ${d.x} \nY: ${d.y}`
      );
    })
    .on("mouseout", () => {
      d3.select("#info-display").text("");
    })
    .on("click", (event, d) => {
      initD3(d.id);
    });
}