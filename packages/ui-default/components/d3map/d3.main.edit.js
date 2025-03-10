import * as d3 from "d3";
import initD3 from "./d3.map";

export default function D3MainEdit() {
  const width = 200;
  const height = 200;

  const urlForHubImage = UiContext.urlForHubImage;

  const svg = d3.select("#d3-main-edit")
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
        `Node ${d.id}: \nContent: ${d.content}`
      );
    })
    .on("mousemove", (event, d) => {
      d3.select("#current-coordinates").text(`X: ${d.x}, Y: ${d.y}`);
    })
    .on("mouseout", () => {
      d3.select("#info-display").text("");
      d3.select("#current-coordinates").text("X: 0, Y: 0");
    })
    .on("click", (event, d) => {
      initD3(d.id);
    })
    .call(d3.drag()
      .on("start", function(event, d) {
        d3.select(this).raise().attr("stroke", "black");
      })
      .on("drag", function(event, d) {
        const [x, y] = d3.pointer(event, svg.node());
        d.x = x;
        d.y = y;
        d3.select(this).attr("cx", d.x).attr("cy", d.y);
        d3.select("#current-coordinates").text(`X: ${d.x}, Y: ${d.y}`);
      })
      .on("end", function(event, d) {
        d3.select(this).attr("stroke", "#fff");
        const updatedNodes = mainNodes.map(node => ({
          id: node.id,
          x: node.x,
          y: node.y
        }));
        const jsonData = JSON.stringify({ nodes: updatedNodes });
        document.getElementById("node-coordinates").value = jsonData;
        document.getElementById("form-data-display").textContent = jsonData;
      })
    );
}