import * as d3 from "d3";

export default function D3Main() {
  const width = 200;
  const height = 200;

  const svg = d3.select("#d3-main")
    .attr("viewBox", [-width / 2, -height / 2, width, height])
    .attr("preserveAspectRatio", "xMidYMid meet")
    .attr("style", "width: 100%; height: 100%;");

  const nodes = UiContext.nodes;
  const links = UiContext.links;

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(30))
    .force("charge", d3.forceManyBody().strength(1))
    .force("center", d3.forceCenter(0, 0))
    .force("radial", d3.forceRadial(80, 0, 0))
    .on("tick", ticked);

  const mainLinks = links.filter(link => 
    nodes.some(node => node.id === link.source) &&
    nodes.some(node => node.id === link.target)
  );

  const link = svg.append("g")
    .attr("stroke", "#999")
    .attr("stroke-opacity", 0.6)
    .selectAll("line")
    .data(mainLinks)
    .enter()
    .append("line");

  const mainNodes = nodes.filter(node => node.type === 'main');

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
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);

    node
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);
  }
}