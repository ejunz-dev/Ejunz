import * as d3 from "d3";

export default function initD3() {
  const width = 200;
  const height = 200;

  const svg = d3.select("#d3-test")
    .attr("viewBox", [-width / 2, -height / 2, width, height])
    .attr("width", width)
    .attr("height", height)
    .attr("style", "max-width: 100%; height: auto;");

  // 力导向图
  const simulation = d3.forceSimulation()
    .force("charge", d3.forceManyBody())
    .force("x", d3.forceX())
    .force("y", d3.forceY())
    .on("tick", ticked);

  let nodes = [{ id: "A" }, { id: "B" }, { id: "C" }];
  let links = [{ source: "A", target: "B" }, { source: "B", target: "C" }];

  let link = svg.append("g")
    .attr("stroke", "#999")
    .attr("stroke-opacity", 0.6)
    .selectAll("line")
    .data(links)
    .enter()
    .append("line");

  let node = svg.append("g")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .selectAll("circle")
    .data(nodes)
    .enter()
    .append("circle")
    .attr("r", 5)
    .attr("fill", "steelblue")
    .call(d3.drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      })
    );

  function ticked() {
    node.attr("cx", d => d.x).attr("cy", d => d.y);
    link.attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);
  }

  simulation.nodes(nodes);
  simulation.force("link", d3.forceLink().id(d => d.id).links(links));
  simulation.alpha(1).restart();
}
